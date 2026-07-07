import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;
const client = twilio(accountSid, authToken);

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

    // 3. Skip if the lead already replied
    const convoSnap = await adminDb
      .collection("conversations")
      .doc(data.conversationId)
      .get();

    const hasReply = convoSnap.exists && convoSnap.data()?.hasReply === true;

    if (hasReply) {
      await doc.ref.update({ status: "skipped", skippedReason: "hasReply" });
      skipped++;
      continue;
    }

    // 4. Skip if the lead opted out (STOP) or got auto-blocked
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

    // 5. Send the follow-up SMS
    try {
      const msg = await client.messages.create({
        to: data.phone,
        body: data.followUpMessage,
        messagingServiceSid: data.messagingServiceSid,
        statusCallback: `${process.env.APP_BASE_URL}/api/send-sms/twilio/status`,
      });

      await doc.ref.update({
        status: "sent",
        sid: msg.sid,
        sentAt: FieldValue.serverTimestamp(),
      });

      // 6. Log it in the conversation thread so it shows up in your dashboard
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
      await doc.ref.update({
        status: "failed",
        error: err?.message || "send failed",
      });
      failed++;
    }
  }

  return NextResponse.json({ ok: true, processed: snap.size, sent, skipped, failed });
}
