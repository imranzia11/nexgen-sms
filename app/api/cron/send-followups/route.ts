import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { sendSmsForUser } from "../../../../lib/twilioSend";

export async function GET(req: NextRequest) {
  // 1. Protect this route so randoms on the internet can't trigger it
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // 2. Find all follow-ups that are due and still pending
  const snap = await adminDb
    .collection("followUps")
    .where("status", "==", "pending")
    .where("dueAt", "<=", now)
    .limit(200)
    .get();

  if (snap.empty) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    // NOTE: This used to skip sending if the lead had already replied
    // (hasReply == true on the conversation). Removed on request - a
    // follow-up should now send unconditionally once its due time arrives,
    // regardless of whether the customer has replied to anything, ever, on
    // this conversation. The only remaining reason to skip is the
    // blocked-number check right below, which stays because it's a legal/
    // compliance requirement (STOP opt-outs), not a business preference.

    // 3. Skip if the lead opted out (STOP) or got auto-blocked
    const blacklistSnap = await adminDb
      .collection("blacklisted_numbers")
      .where("ownerUid", "==", data.ownerUid)
      .where("phone", "==", data.phone)
      .limit(1)
      .get();

    const isBlocked =
      !blacklistSnap.empty &&
      String(blacklistSnap.docs[0].data()?.status || "").toLowerCase() === "blocked";

    if (isBlocked) {
      await doc.ref.update({ status: "skipped", skippedReason: "blocked" });
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
