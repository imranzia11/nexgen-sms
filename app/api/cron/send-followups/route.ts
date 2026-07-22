import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { sendSmsForUser } from "../../../../lib/twilioSend";
import { phoneDocId } from "../../../../lib/phone";

export async function GET(req: NextRequest) {
  // 1. Protect this route so randoms on the internet can't trigger it
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // 2. Find all follow-ups that are due and still pending
  //
  // BUG FIX: raised from 200 - a mass campaign's follow-ups can all share
  // nearly the same dueAt (each is original send time + N hours, and a
  // bulk send's messages typically go out within one tight window), so
  // thousands can become due within roughly the same hour. At 200 per run
  // on a 15-minute schedule, that's only ~800/hour of throughput, well
  // below what a single large campaign's follow-up wave can produce -
  // exactly what caused a real backlog (and a growing "most overdue" lag)
  // after the ~5,000-lead "july22 Abe10:46" recovery. Raised to 500 for
  // roughly 2.5x throughput. Paired with the blacklist-check batching
  // fix directly below (previously one Firestore query PER follow-up,
  // now one query per distinct owner) so the extra items don't push this
  // request close to the platform's ~5 minute timeout.
  const snap = await adminDb
    .collection("followUps")
    .where("status", "==", "pending")
    .where("dueAt", "<=", now)
    .limit(500)
    .get();

  if (snap.empty) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // BUG FIX: this used to run a separate Firestore query PER follow-up
  // just to check if that number was blacklisted - 200 (now up to 500)
  // individual round trips per run, the single biggest reason a run took
  // as long as it did. Batched here instead: one query per DISTINCT owner
  // represented in this batch (almost always a small number, run in
  // parallel), building an in-memory blocked-phone Set per owner that the
  // loop below just checks against - zero additional Firestore reads per
  // item. Mirrors the same fix already applied to /api/schedule-follow-up.
  const ownerUids = Array.from(
    new Set(snap.docs.map((d) => String(d.data()?.ownerUid || "")).filter(Boolean))
  );

  const blockedPhonesByOwner = new Map<string, Set<string>>();
  await Promise.all(
    ownerUids.map(async (ownerUid) => {
      const blacklistSnap = await adminDb
        .collection("blacklisted_numbers")
        .where("ownerUid", "==", ownerUid)
        .where("status", "==", "blocked")
        .get();

      blockedPhonesByOwner.set(
        ownerUid,
        new Set(
          blacklistSnap.docs.map((d) => phoneDocId(String(d.data()?.phone || "")))
        )
      );
    })
  );

  // REVERTED ON REQUEST: this hasReply skip used to exist, was removed
  // earlier (task #86) so a follow-up would send unconditionally once due,
  // and is being restored now - a real example showed a follow-up going
  // out to a customer who had already replied "wrong number," which isn't
  // a lead worth following up with. hasReply reflects the CURRENT state at
  // send time (re-checked here, not the state when the follow-up was
  // originally scheduled), since a reply can easily arrive during the
  // hours between scheduling and the follow-up's due time. Batch-fetched
  // via getAll() (one round trip per 300 conversations, chunked the same
  // way the recovery scripts already do) rather than one read per
  // follow-up, so this doesn't reintroduce the N+1 pattern just fixed
  // above for the blacklist check.
  const conversationIds = Array.from(
    new Set(snap.docs.map((d) => String(d.data()?.conversationId || "")).filter(Boolean))
  );

  const hasReplyByConversationId = new Map<string, boolean>();
  const GETALL_CHUNK = 300;
  for (let i = 0; i < conversationIds.length; i += GETALL_CHUNK) {
    const chunkIds = conversationIds.slice(i, i + GETALL_CHUNK);
    const refs = chunkIds.map((id) => adminDb.collection("conversations").doc(id));
    const convoSnaps = await adminDb.getAll(...refs);
    convoSnaps.forEach((convoSnap) => {
      hasReplyByConversationId.set(convoSnap.id, convoSnap.exists && convoSnap.data()?.hasReply === true);
    });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    // 3. Skip if the lead opted out (STOP) or got auto-blocked
    const isBlocked =
      blockedPhonesByOwner
        .get(String(data.ownerUid || ""))
        ?.has(phoneDocId(String(data.phone || ""))) ?? false;

    if (isBlocked) {
      await doc.ref.update({ status: "skipped", skippedReason: "blocked" });
      skipped++;
      continue;
    }

    // 3b. Skip if the customer has replied to anything in this
    // conversation since the follow-up was scheduled - a reply (even a
    // "wrong number" or "not interested") means an automated nudge is no
    // longer appropriate.
    const customerAlreadyReplied =
      hasReplyByConversationId.get(String(data.conversationId || "")) ?? false;

    if (customerAlreadyReplied) {
      await doc.ref.update({ status: "skipped", skippedReason: "customer_replied" });
      skipped++;
      continue;
    }

    // 4. Send the follow-up SMS. Routed through the shared sendSmsForUser
    // helper so `from` is always pinned to the number stored on the
    // followUps doc, never picked from the shared Messaging Service pool.
    try {
      const msg = await sendSmsForUser({
        userData: {
          twilioNumber: data.twilioNumber,
          messagingServiceSid: data.messagingServiceSid,
        },
        to: data.phone,
        body: data.followUpMessage,
      });

      await doc.ref.update({
        status: "sent",
        sid: msg.sid,
        sentAt: FieldValue.serverTimestamp(),
      });

      // 5. Log it in the conversation thread so it shows up in your dashboard
      const convoRef = adminDb.collection("conversations").doc(data.conversationId);

      await convoRef.collection("messages").doc(msg.sid).set({
        sid: msg.sid,
        ownerUid: data.ownerUid,
        conversationId: data.conversationId,
        from: msg.from || data.twilioNumber,
        to: data.phone,
        phone: data.phone,
        body: data.followUpMessage,
        direction: "outbound",
        status: msg.status || "queued",
        read: true,
        isFollowUp: true,
        twilioNumber: data.twilioNumber,
        messagingServiceSid: data.messagingServiceSid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await convoRef.set(
        {
          lastMessage: data.followUpMessage,
          lastDirection: "outbound",
          lastMessageAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          outboundCount: FieldValue.increment(1),
          messageCount: FieldValue.increment(1),
          lastOutboundAt: FieldValue.serverTimestamp(),
          lastOutboundStatus: msg.status || "queued",
        },
        { merge: true }
      );

      sent++;
    } catch (err: any) {
      const errorMessage = err?.message || "send failed";
      const errorCode = err?.code ? String(err.code) : "";

      await doc.ref.update({
        status: "failed",
        error: errorMessage,
      });

      // Previously a failed follow-up only updated its own followUps doc -
      // invisible in the conversation thread and never counted toward the
      // Failed/Undelivered tab, unlike a normal send failure. Best-effort:
      // a logging problem here shouldn't stop the rest of the batch from
      // processing.
      try {
        const convoRef = adminDb.collection("conversations").doc(data.conversationId);
        const convoSnap = await convoRef.get();
        const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

        await convoRef.collection("messages").doc().set({
          sid: "",
          ownerUid: data.ownerUid,
          conversationId: data.conversationId,
          from: data.twilioNumber,
          to: data.phone,
          phone: data.phone,
          body: data.followUpMessage,
          direction: "outbound",
          status: "failed",
          error: errorMessage,
          errorCode,
          read: true,
          isFollowUp: true,
          twilioNumber: data.twilioNumber,
          messagingServiceSid: data.messagingServiceSid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        await convoRef.set(
          {
            lastMessage: data.followUpMessage,
            lastDirection: "outbound",
            lastMessageAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            status: "delivery_issue",
            lastOutboundAt: FieldValue.serverTimestamp(),
            lastOutboundStatus: "failed",
            blocked: convoData.blocked === true,
          },
          { merge: true }
        );
      } catch (logError) {
        console.error("send-followups: failed to log failure to conversation", logError);
      }

      failed++;
    }
  }

  return NextResponse.json({ ok: true, processed: snap.size, sent, skipped, failed });
}
