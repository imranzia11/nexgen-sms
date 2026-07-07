import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";

type Recipient = {
  name?: string;
  phone: string;
};

// Normalizes any phone input to E164 format (e.g. "+15163201666").
// This MUST match the toE164 logic used in /api/send-sms so that
// conversationId values line up across both code paths.
function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

export async function POST(req: NextRequest) {
  try {
    const decodedUser = await getUserFromRequest(req);
    const uid = decodedUser.uid;

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

    const batch = adminDb.batch();
    let scheduled = 0;
    let invalid = 0;
    let superseded = 0;

    for (const recipient of recipients) {
      // Normalize to E164 BEFORE building conversationId, so this matches
      // the ID that /api/send-sms and the thread page compute.
      const phone = toE164(recipient.phone || "");
      if (!phone) {
        invalid++;
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
      const existingPendingSnap = await adminDb
        .collection("followUps")
        .where("ownerUid", "==", uid)
        .where("conversationId", "==", conversationId)
        .where("status", "==", "pending")
        .get();

      existingPendingSnap.docs.forEach((existingDoc) => {
        batch.update(existingDoc.ref, {
          status: "superseded",
          supersededAt: FieldValue.serverTimestamp(),
          supersededReason: "Replaced by a newer follow-up for this lead.",
        });
        superseded++;
      });

      const ref = adminDb.collection("followUps").doc();

      batch.set(ref, {
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
      });

      scheduled++;
    }

    await batch.commit();

    return NextResponse.json({
      ok: true,
      scheduled,
      invalid,
      superseded,
      dueAt: dueAt.toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to schedule follow-up." },
      { status: 500 }
    );
  }
}
