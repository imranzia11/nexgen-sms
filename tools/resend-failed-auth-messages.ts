// Twilio was out of balance for a window and every outbound send during
// that time failed instantly at the API level with error 20003
// ("Authenticate") rather than a normal per-recipient delivery failure
// (like 30006 landline, 30003 unreachable handset, etc). That distinction
// matters: 20003 says nothing about the recipient's number being bad, it
// just means Twilio rejected the request outright — so unlike a real
// delivery failure, these are safe and correct to retry once the account
// is funded again.
//
// This scans the root `messages` collection for status "failed" +
// errorCode "20003", skips anything that would be unsafe to resend
// (recipient blacklisted per-owner or opted out platform-wide since, or a
// later message on that same conversation already went out fine), and
// resends the exact original body verbatim — no re-personalization — so
// this is a faithful retry, not a new message.
//
// Usage:
//   npx tsx tools/resend-failed-auth-messages.ts                # dry run
//   npx tsx tools/resend-failed-auth-messages.ts --apply         # actually resend
//   npx tsx tools/resend-failed-auth-messages.ts --error=20003 --apply
//
// Without --apply, only prints what WOULD be resent.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const apply = process.argv.includes("--apply");
  const errorArg = process.argv.find((a) => a.startsWith("--error="));
  const targetErrorCode = errorArg ? errorArg.split("=")[1] : "20003";

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { sendSmsForUser, BlockedNumberError } = await import("../lib/twilioSend");
  const { toE164, phoneDocId } = await import("../lib/phone");

  console.log(`Looking for failed messages with errorCode=${targetErrorCode}...\n`);

  const failedSnap = await adminDb
    .collection("messages")
    .where("status", "==", "failed")
    .where("errorCode", "==", targetErrorCode)
    .get();

  if (failedSnap.empty) {
    console.log("No matching failed messages found.");
    return;
  }

  console.log(`Found ${failedSnap.size} failed message(s) with this error.\n`);

  const userCache = new Map<string, FirebaseFirestore.DocumentData | null>();
  const getUser = async (uid: string) => {
    if (userCache.has(uid)) return userCache.get(uid);
    const snap = await adminDb.collection("users").doc(uid).get();
    const data = snap.exists ? snap.data() || {} : null;
    userCache.set(uid, data);
    return data;
  };

  const eligible: Array<{
    docId: string;
    ownerUid: string;
    phone: string;
    body: string;
    campaignName: string;
    fileId: string;
    fileName: string;
    mediaUrls: string[];
    createdAtMs: number;
  }> = [];

  const skipped: Array<{ phone: string; ownerUid: string; reason: string }> = [];

  for (const doc of failedSnap.docs) {
    const data = doc.data() || {};
    const ownerUid = String(data.ownerUid || "");
    const phone = toE164(String(data.phone || data.to || ""));
    const body = String(data.body || "").trim();

    if (!ownerUid || !phone) {
      skipped.push({ phone: phone || "(none)", ownerUid: ownerUid || "(none)", reason: "missing ownerUid or phone" });
      continue;
    }

    if (!body) {
      skipped.push({ phone, ownerUid, reason: "empty body (nothing to resend)" });
      continue;
    }

    const userData = await getUser(ownerUid);
    if (!userData || userData.isActive !== true) {
      skipped.push({ phone, ownerUid, reason: "owner account missing or inactive" });
      continue;
    }

    const blacklistSnap = await adminDb
      .collection("blacklisted_numbers")
      .where("ownerUid", "==", ownerUid)
      .where("phone", "==", phone)
      .limit(1)
      .get();

    const blacklisted = blacklistSnap.docs.some(
      (d) => String(d.data()?.status || "").toLowerCase() === "blocked"
    );

    if (blacklisted) {
      skipped.push({ phone, ownerUid, reason: "blacklisted (opted out or manually blocked) since the failure" });
      continue;
    }

    const convoId = `${ownerUid}_${phoneDocId(phone)}`;
    const convoSnap = await adminDb.collection("conversations").doc(convoId).get();
    const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

    const failedCreatedAtMs =
      typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : 0;
    const lastMessageAtMs =
      typeof convoData.lastMessageAt?.toMillis === "function"
        ? convoData.lastMessageAt.toMillis()
        : 0;
    const lastOutboundStatus = String(convoData.lastOutboundStatus || "").toLowerCase();
    const successfulStatuses = new Set(["queued", "accepted", "scheduled", "sending", "sent", "delivered"]);

    if (
      lastMessageAtMs > failedCreatedAtMs &&
      successfulStatuses.has(lastOutboundStatus)
    ) {
      skipped.push({ phone, ownerUid, reason: "a later message on this conversation already went out fine" });
      continue;
    }

    eligible.push({
      docId: doc.id,
      ownerUid,
      phone,
      body,
      campaignName: String(data.campaignName || ""),
      fileId: String(data.fileId || ""),
      fileName: String(data.fileName || ""),
      mediaUrls: Array.isArray(data.mediaUrls) ? data.mediaUrls : [],
      createdAtMs: failedCreatedAtMs,
    });
  }

  console.log("=== Result ===");
  console.log(`  eligible to resend: ${eligible.length}`);
  console.log(`  skipped:            ${skipped.length}`);
  console.log("");

  if (eligible.length > 0) {
    console.log("Would resend:");
    for (const e of eligible) {
      const preview = e.body.length > 90 ? `${e.body.slice(0, 90)}...` : e.body;
      console.log(`  ${e.docId}  phone=${e.phone}  ownerUid=${e.ownerUid}  campaign="${e.campaignName}"  body="${preview}"`);
    }
    console.log("");
  }

  if (skipped.length > 0) {
    console.log("Skipped:");
    for (const s of skipped) {
      console.log(`  phone=${s.phone}  ownerUid=${s.ownerUid}  (${s.reason})`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("DRY RUN - nothing sent. Re-run with --apply to actually resend these.");
    return;
  }

  if (eligible.length === 0) {
    console.log("Nothing eligible to resend.");
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const e of eligible) {
    try {
      const userData = (await getUser(e.ownerUid)) || {};

      const res = await sendSmsForUser({
        userData,
        to: e.phone,
        body: e.body,
        mediaUrls: e.mediaUrls,
      });

      const convoId = `${e.ownerUid}_${phoneDocId(e.phone)}`;
      const convoRef = adminDb.collection("conversations").doc(convoId);
      const existingConvoSnap = await convoRef.get();
      const existingConvo = existingConvoSnap.exists ? existingConvoSnap.data() || {} : {};

      await convoRef.collection("messages").doc(res.sid).set({
        sid: res.sid,
        ownerUid: e.ownerUid,
        conversationId: convoId,
        from: res.from,
        to: e.phone,
        phone: e.phone,
        body: e.body,
        mediaUrls: e.mediaUrls,
        direction: "outbound",
        status: res.status || "queued",
        read: true,
        resentFromMessageId: e.docId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await convoRef.set(
        {
          ownerUid: e.ownerUid,
          phone: e.phone,
          lastMessage: e.body,
          lastDirection: "outbound",
          lastMessageAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          status: existingConvo.hasReply === true ? "replied" : "awaiting_reply",
          lastOutboundAt: FieldValue.serverTimestamp(),
          lastOutboundStatus: res.status || "queued",
          blocked: false,
        },
        { merge: true }
      );

      await adminDb.collection("messages").add({
        ownerUid: e.ownerUid,
        conversationId: convoId,
        campaignName: e.campaignName,
        fileId: e.fileId,
        fileName: e.fileName,
        phone: e.phone,
        to: e.phone,
        from: res.from,
        body: e.body,
        mediaUrls: e.mediaUrls,
        sid: res.sid,
        twilioSid: res.sid,
        status: res.status || "queued",
        direction: "outbound",
        read: true,
        error: "",
        resentFromMessageId: e.docId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await adminDb.collection("messages").doc(e.docId).update({
        resent: true,
        resentAt: FieldValue.serverTimestamp(),
        resentSid: res.sid,
      });

      sent++;
      console.log(`Resent to ${e.phone} (sid ${res.sid}, status ${res.status}).`);
    } catch (err) {
      failed++;
      const message =
        err instanceof BlockedNumberError
          ? err.message
          : (err as { message?: string })?.message || String(err);
      console.error(`Failed to resend to ${e.phone}: ${message}`);
    }
  }

  console.log("");
  console.log(`Done - resent ${sent}, failed ${failed}, skipped ${skipped.length}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
