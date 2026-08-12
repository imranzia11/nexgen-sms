// Twilio error 21606 ("The From phone number ... is not a valid, SMS-capable
// inbound phone number ... for your account") means the `twilioNumber`
// saved on the user's own account doc was malformed at send time - in this
// case missing its leading "1" (saved as "+9705358848" instead of
// "+19705358848"). That's a config problem, not a real per-recipient
// delivery failure, so once the user's twilioNumber is corrected it's safe
// to resend the exact same message.
//
// Unlike tools/resend-failed-auth-messages.ts (which keeps the original
// failed record and just marks it `resent: true` for audit history), this
// script actually DELETES the failed record - both the root `messages` doc
// and the matching failed doc(s) in the conversation's own message thread
// (conversations/{id}/messages) - per explicit request, since these
// weren't real send attempts a customer ever saw, just a config error.
//
// Refuses to run if the account's twilioNumber still doesn't look like a
// valid "+1XXXXXXXXXX" number, so this can't blindly re-fail the exact
// same way if the underlying fix wasn't actually applied yet.
//
// Usage:
//   npx tsx tools/resend-and-clean-invalid-from-number.ts --email=charles@nexgen.com                 (dry run)
//   npx tsx tools/resend-and-clean-invalid-from-number.ts --email=charles@nexgen.com --apply
//   npx tsx tools/resend-and-clean-invalid-from-number.ts --email=charles@nexgen.com --error=21606 --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const apply = process.argv.includes("--apply");
  const emailArg = process.argv.find((a) => a.startsWith("--email="));
  const errorArg = process.argv.find((a) => a.startsWith("--error="));
  const targetErrorCode = errorArg ? errorArg.split("=")[1] : "21606";
  const email = emailArg ? emailArg.split("=")[1].trim().toLowerCase() : "";

  if (!email) {
    console.error("Usage: npx tsx tools/resend-and-clean-invalid-from-number.ts --email=someone@example.com [--apply] [--error=21606]");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { sendSmsForUser, BlockedNumberError } = await import("../lib/twilioSend");
  const { toE164, phoneDocId } = await import("../lib/phone");

  const userSnap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
  if (userSnap.empty) {
    console.error(`No user found with email ${email}.`);
    process.exit(1);
  }

  const ownerUid = userSnap.docs[0].id;
  const userData = userSnap.docs[0].data() || {};

  console.log(`Account: ${userData.name || email} (${ownerUid})`);

  if (userData.isActive !== true) {
    console.error("This account is not active - refusing to resend. Fix that first.");
    process.exit(1);
  }

  const currentTwilioNumber = String(userData.twilioNumber || userData.assignedTwilioNumber || "");
  if (!/^\+1\d{10}$/.test(currentTwilioNumber)) {
    console.error(
      `This account's twilioNumber is "${currentTwilioNumber}" - still doesn't look like a valid "+1XXXXXXXXXX" number. Fix that in Firestore first, then re-run this.`
    );
    process.exit(1);
  }

  console.log(`twilioNumber looks valid: ${currentTwilioNumber}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Looking for this account's failed messages with errorCode=${targetErrorCode}...\n`);

  const failedSnap = await adminDb
    .collection("messages")
    .where("ownerUid", "==", ownerUid)
    .where("status", "==", "failed")
    .where("errorCode", "==", targetErrorCode)
    .get();

  if (failedSnap.empty) {
    console.log("No matching failed messages found for this account.");
    return;
  }

  console.log(`Found ${failedSnap.size} failed message(s) with this error.\n`);

  const eligible: Array<{
    docId: string;
    phone: string;
    body: string;
    campaignName: string;
    fileId: string;
    fileName: string;
    mediaUrls: string[];
    convoId: string;
  }> = [];

  const skipped: Array<{ phone: string; reason: string }> = [];

  // Chunked/parallel instead of one-by-one - these are all reads (no side
  // effects), so it's safe to fan them out. At 1,500+ failed messages,
  // doing this sequentially made even the dry run take several minutes;
  // batches of 25 concurrent lookups is a big speedup without hammering
  // Firestore hard enough to matter.
  const CONCURRENCY = 25;

  async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) {
      await Promise.all(items.slice(i, i + size).map(fn));
    }
  }

  await inBatches(failedSnap.docs, CONCURRENCY, async (doc) => {
    const data = doc.data() || {};
    const phone = toE164(String(data.phone || data.to || ""));
    const body = String(data.body || "").trim();

    if (!phone) {
      skipped.push({ phone: "(none)", reason: "missing phone" });
      return;
    }
    if (!body) {
      skipped.push({ phone, reason: "empty body (nothing to resend)" });
      return;
    }

    const [blacklistSnap, convoSnap] = await Promise.all([
      adminDb
        .collection("blacklisted_numbers")
        .where("ownerUid", "==", ownerUid)
        .where("phone", "==", phone)
        .limit(1)
        .get(),
      adminDb.collection("conversations").doc(`${ownerUid}_${phoneDocId(phone)}`).get(),
    ]);

    const blacklisted = blacklistSnap.docs.some(
      (d) => String(d.data()?.status || "").toLowerCase() === "blocked"
    );

    if (blacklisted) {
      skipped.push({ phone, reason: "blacklisted (opted out or manually blocked) since the failure" });
      return;
    }

    const convoId = `${ownerUid}_${phoneDocId(phone)}`;
    const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

    const failedCreatedAtMs = typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : 0;
    const lastMessageAtMs =
      typeof convoData.lastMessageAt?.toMillis === "function" ? convoData.lastMessageAt.toMillis() : 0;
    const lastOutboundStatus = String(convoData.lastOutboundStatus || "").toLowerCase();
    const successfulStatuses = new Set(["queued", "accepted", "scheduled", "sending", "sent", "delivered"]);

    if (lastMessageAtMs > failedCreatedAtMs && successfulStatuses.has(lastOutboundStatus)) {
      skipped.push({ phone, reason: "a later message on this conversation already went out fine" });
      return;
    }

    eligible.push({
      docId: doc.id,
      phone,
      body,
      campaignName: String(data.campaignName || ""),
      fileId: String(data.fileId || ""),
      fileName: String(data.fileName || ""),
      mediaUrls: Array.isArray(data.mediaUrls) ? data.mediaUrls : [],
      convoId,
    });
  });

  // Dedupe by conversation + BODY (not conversation alone): if a phone has
  // two (or more) separate failed root `messages` docs with the SAME text,
  // each one would otherwise get picked up as independently "eligible" and
  // resend the identical message multiple times in one run (confirmed to
  // actually happen - see tools/remove-duplicate-resent-messages.ts,
  // written to clean up the fallout from before this dedupe existed).
  //
  // Deduping on conversation alone was tried first and is wrong: an
  // account can have TWO DIFFERENT campaigns fail to the same lead before
  // the twilioNumber was fixed, and collapsing those to "just resend one"
  // would silently drop a real, distinct message the customer never got -
  // and (see below) the old thread-cleanup step would then delete BOTH
  // failed thread bubbles regardless, erasing the second message's content
  // entirely with nothing left to retry. Keying on convoId+body instead
  // means only genuinely identical repeated failures get collapsed; two
  // different messages to the same lead both stay eligible and both get
  // resent (and cleaned up) independently.
  const seenConvoBodyKeys = new Set<string>();
  const deduped: typeof eligible = [];
  for (const e of eligible) {
    const key = `${e.convoId}|${e.body}`;
    if (seenConvoBodyKeys.has(key)) {
      skipped.push({ phone: e.phone, reason: `duplicate: another failed message with the same text for this conversation is already being resent in this run` });
      continue;
    }
    seenConvoBodyKeys.add(key);
    deduped.push(e);
  }
  eligible.length = 0;
  eligible.push(...deduped);

  // One subcollection query per unique conversation, not per root message -
  // the same conversation can have multiple duplicate failed attempts (as
  // seen in this exact case: two identical failed bubbles on one thread).
  // Also parallelized. Results are grouped by BODY within each
  // conversation (not just fetched as one flat list) so that when a
  // conversation has failed attempts with two DIFFERENT bodies, resending
  // one of them only deletes the thread doc(s) that actually match what
  // was just resent - not every failed doc in the thread regardless of
  // content, which used to risk erasing a distinct, never-resent message.
  const uniqueConvoIds = Array.from(new Set(eligible.map((e) => e.convoId)));
  const threadDocsByConvoAndBody = new Map<string, Map<string, string[]>>();

  await inBatches(uniqueConvoIds, CONCURRENCY, async (convoId) => {
    const threadFailedSnap = await adminDb
      .collection("conversations")
      .doc(convoId)
      .collection("messages")
      .where("status", "==", "failed")
      .where("errorCode", "==", targetErrorCode)
      .get();

    const byBody = new Map<string, string[]>();
    for (const d of threadFailedSnap.docs) {
      const docBody = String(d.data()?.body || "").trim();
      const list = byBody.get(docBody) || [];
      list.push(d.id);
      byBody.set(docBody, list);
    }
    threadDocsByConvoAndBody.set(convoId, byBody);
  });

  function threadDocIdsFor(e: { convoId: string; body: string }): string[] {
    return threadDocsByConvoAndBody.get(e.convoId)?.get(e.body) || [];
  }

  const totalThreadDocs = eligible.reduce((sum, e) => sum + threadDocIdsFor(e).length, 0);

  console.log("=== Result ===");
  console.log(`  eligible to resend:              ${eligible.length}`);
  console.log(`  root "messages" docs to delete:  ${eligible.length}`);
  console.log(`  thread message docs to delete:   ${totalThreadDocs}`);
  console.log(`  skipped:                          ${skipped.length}`);
  console.log("");

  if (eligible.length > 0) {
    console.log("Would resend + delete:");
    for (const e of eligible) {
      const preview = e.body.length > 90 ? `${e.body.slice(0, 90)}...` : e.body;
      console.log(`  phone=${e.phone}  campaign="${e.campaignName}"  body="${preview}"`);
    }
    console.log("");
  }

  if (skipped.length > 0) {
    console.log("Skipped (not resent, not deleted):");
    for (const s of skipped) {
      console.log(`  phone=${s.phone}  (${s.reason})`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("DRY RUN - nothing sent or deleted. Re-run with --apply to actually do this.");
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
      const res = await sendSmsForUser({
        userData,
        to: e.phone,
        body: e.body,
        mediaUrls: e.mediaUrls,
      });

      const convoRef = adminDb.collection("conversations").doc(e.convoId);
      const existingConvoSnap = await convoRef.get();
      const existingConvo = existingConvoSnap.exists ? existingConvoSnap.data() || {} : {};

      await convoRef.collection("messages").doc(res.sid).set({
        sid: res.sid,
        ownerUid,
        conversationId: e.convoId,
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
          ownerUid,
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
        ownerUid,
        conversationId: e.convoId,
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

      // Only delete the old failed records AFTER a successful resend -
      // if sendSmsForUser throws, the original failed record stays put and
      // this conversation just gets retried on the next run instead of
      // silently losing the record of what happened.
      await adminDb.collection("messages").doc(e.docId).delete();

      const threadDocIds = threadDocIdsFor(e);
      for (const threadDocId of threadDocIds) {
        await convoRef.collection("messages").doc(threadDocId).delete();
      }

      sent++;
      console.log(`Resent to ${e.phone} (sid ${res.sid}, status ${res.status}) - deleted 1 root + ${threadDocIds.length} thread failed record(s).`);
    } catch (err) {
      failed++;
      const message =
        err instanceof BlockedNumberError
          ? err.message
          : (err as { message?: string })?.message || String(err);
      console.error(`Failed to resend to ${e.phone}: ${message} - original failed record(s) left in place.`);
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
