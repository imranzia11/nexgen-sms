import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";
import { toE164, phoneDocId } from "../../../lib/phone";

type Recipient = {
  name?: string;
  phone: string;
};

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

export async function POST(req: NextRequest) {
  // Declared here (not inside the try block) so the catch block below can
  // still reference whatever was known at the point of failure, for the
  // error log - see task #82: 3 of 4 follow-up-enabled sends on one
  // account silently failed to create any followUps doc, with nothing
  // recording why. A toast the user might not have seen was the only
  // trace; this gives it a permanent, queryable record instead.
  let uid: string | undefined;
  let campaignNameForLog: string | undefined;
  let recipientCountForLog: number | undefined;

  try {
    const decodedUser = await getUserFromRequest(req);
    uid = decodedUser.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return NextResponse.json(
        { ok: false, error: "User profile not found." },
        { status: 404 }
      );
    }

    const userData = userSnap.data() || {};

    if (userData.isActive !== true) {
      return NextResponse.json(
        { ok: false, error: "User account is inactive." },
        { status: 403 }
      );
    }

    const twilioNumber = String(
      userData.twilioNumber || userData.assignedTwilioNumber || ""
    );

    const body = await req.json();

    const {
      campaignName,
      fileId,
      fileName,
      message,
      delayHours,
      recipients,
    }: {
      campaignName?: string;
      fileId?: string;
      fileName?: string;
      message?: string;
      delayHours?: number;
      recipients?: Recipient[];
    } = body;

    campaignNameForLog = campaignName;
    recipientCountForLog = Array.isArray(recipients) ? recipients.length : 0;

    if (!message?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Follow-up message is required." },
        { status: 400 }
      );
    }

    if (!delayHours || Number(delayHours) <= 0) {
      return NextResponse.json(
        { ok: false, error: "A valid delayHours is required." },
        { status: 400 }
      );
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No recipients provided." },
        { status: 400 }
      );
    }

    const dueAt = new Date(Date.now() + Number(delayHours) * 60 * 60 * 1000);

    // Both fetched once up front instead of once per recipient (the old
    // code ran a fresh Firestore query inside the loop for every single
    // recipient, which meaningfully slows down large batches). Grouping
    // into a Map/Set here means the loop below does no Firestore reads at
    // all, only the one write batch at the end.
    const [pendingFollowUpsSnap, blacklistSnap] = await Promise.all([
      adminDb
        .collection("followUps")
        .where("ownerUid", "==", uid)
        .where("status", "==", "pending")
        .get(),
      adminDb.collection("blacklisted_numbers").where("ownerUid", "==", uid).get(),
    ]);

    const pendingByConversation = new Map<
      string,
      FirebaseFirestore.QueryDocumentSnapshot[]
    >();
    pendingFollowUpsSnap.docs.forEach((existingDoc) => {
      const conversationId = String(existingDoc.data()?.conversationId || "");
      if (!conversationId) return;
      const list = pendingByConversation.get(conversationId) || [];
      list.push(existingDoc);
      pendingByConversation.set(conversationId, list);
    });

    // FIX: previously this route queued a follow-up unconditionally,
    // relying entirely on the send-followups cron to skip already-blocked
    // numbers at send time. That's still a safe backstop (nothing ever
    // actually gets sent to a blocked number), but it meant scheduling a
    // follow-up for someone who already opted out, only for it to be
    // silently thrown away hours later - wasted writes, and no visibility
    // here that it was even skipped. Checking upfront lets us report it
    // accurately in the response instead.
    const blockedPhoneKeys = new Set<string>();
    blacklistSnap.docs.forEach((blacklistDoc) => {
      const data = blacklistDoc.data() || {};
      if (String(data.status || "").toLowerCase() === "blocked") {
        blockedPhoneKeys.add(phoneDocId(String(data.phone || "")));
      }
    });

    // Firestore hard-caps a single batch at 500 mutations. A big blast can
    // produce up to 2 mutations per recipient (superseding an old pending
    // follow-up + creating the new one), so at a few thousand recipients a
    // single batch would exceed that cap - and batch.commit() is all-or-
    // nothing, so the ENTIRE follow-up schedule would silently fail, not
    // just the overflow. Chunking into multiple batches (committing as the
    // limit is approached) means a big blast becomes several batches
    // instead of one that's guaranteed to fail past ~250 recipients.
    const BATCH_MUTATION_LIMIT = 400;
    let batch = adminDb.batch();
    let opsInBatch = 0;
    let scheduled = 0;
    let invalid = 0;
    let blocked = 0;
    let superseded = 0;

    async function queueOp(apply: (b: FirebaseFirestore.WriteBatch) => void) {
      apply(batch);
      opsInBatch++;
      if (opsInBatch >= BATCH_MUTATION_LIMIT) {
        await batch.commit();
        batch = adminDb.batch();
        opsInBatch = 0;
      }
    }

    for (const recipient of recipients) {
      // Normalize to E164 BEFORE building conversationId, so this matches
      // the ID that /api/send-sms and the thread page compute.
      const phone = toE164(recipient.phone || "");
      if (!phone) {
        invalid++;
        continue;
      }

      if (blockedPhoneKeys.has(phoneDocId(phone))) {
        blocked++;
        continue;
      }

      const conversationId = `${uid}_${phoneDocId(phone)}`;

      // FIX: without this, sending a follow-up-enabled campaign to a lead
      // more than once (e.g. re-testing, or a second outreach) leaves the
      // OLDER pending follow-up docs still sitting in the queue alongside
      // the new one. The cron correctly fires each doc exactly once, but
      // since nothing ever cancels the earlier ones, the same lead ends up
      // getting the same follow-up text multiple times, hours apart, as
      // each stacked doc reaches its own dueAt. Cancel any still-pending
      // follow-ups for this exact conversation before queuing the new one,
      // so only the latest follow-up is ever active per conversation.
      const existingPending = pendingByConversation.get(conversationId) || [];

      for (const existingDoc of existingPending) {
        await queueOp((b) =>
          b.update(existingDoc.ref, {
            status: "superseded",
            supersededAt: FieldValue.serverTimestamp(),
            supersededReason: "Replaced by a newer follow-up for this lead.",
          })
        );
        superseded++;
      }

      const ref = adminDb.collection("followUps").doc();

      await queueOp((b) =>
        b.set(ref, {
          ownerUid: uid,
          conversationId,
          phone, // now guaranteed E164
          twilioNumber,
          messagingServiceSid: userData.messagingServiceSid || "",
          campaignName: campaignName || "",
          fileId: fileId || "",
          fileName: fileName || "",
          followUpMessage: message.trim(),
          delayHours: Number(delayHours),
          dueAt,
          status: "pending",
          createdAt: FieldValue.serverTimestamp(),
        })
      );

      scheduled++;
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }

    return NextResponse.json({
      ok: true,
      scheduled,
      invalid,
      blocked,
      superseded,
      dueAt: dueAt.toISOString(),
    });
  } catch (err: any) {
    const errorMessage = err?.message || "Failed to schedule follow-up.";
    console.error("schedule-follow-up failed", { uid, errorMessage });

    // Best-effort, append-only log so a silent failure like this is
    // traceable afterward - not just a toast the user may have missed. A
    // logging problem here must never mask the real error being returned
    // to the client below.
    if (uid) {
      try {
        await adminDb.collection("followUpScheduleErrors").add({
          ownerUid: uid,
          error: errorMessage,
          campaignName: campaignNameForLog || "",
          recipientCount: recipientCountForLog ?? 0,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (logError) {
        console.error(
          "schedule-follow-up: failed to write error log (non-fatal)",
          logError
        );
      }
    }

    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: 500 }
    );
  }
}
