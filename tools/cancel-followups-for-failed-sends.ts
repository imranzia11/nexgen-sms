// WRITES to Firestore (after printing everything first, dry-run by
// default). One-time backfill companion to the fix in
// app/api/send-sms/twilio/status/route.ts, which cancels a pending
// follow-up automatically whenever a NEW delivery-failure webhook comes
// in - but that only covers failures reported AFTER the fix went live.
// Any follow-up that was already sitting "pending" for a message that had
// ALREADY failed before the fix existed was never touched (Twilio doesn't
// replay old webhook calls just because the code changed), so this scans
// every currently-pending follow-up system-wide and cancels the ones
// whose conversation already shows a permanent delivery failure.
//
// Usage:
//   npx tsx tools/cancel-followups-for-failed-sends.ts [--apply]
//
// Without --apply, only prints what WOULD be cancelled (dry run).

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const apply = process.argv.includes("--apply");

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  const pendingSnap = await adminDb
    .collection("followUps")
    .where("status", "==", "pending")
    .get();

  if (pendingSnap.empty) {
    console.log("No pending followUps docs found anywhere - nothing to check.");
    return;
  }

  console.log(`Checking ${pendingSnap.size} pending followUps doc(s)...\n`);

  const conversationIds = Array.from(
    new Set(
      pendingSnap.docs
        .map((d) => String(d.data()?.conversationId || ""))
        .filter(Boolean)
    )
  );

  const conversationById = new Map<string, FirebaseFirestore.DocumentData>();
  const GETALL_CHUNK = 300;
  for (let i = 0; i < conversationIds.length; i += GETALL_CHUNK) {
    const chunkIds = conversationIds.slice(i, i + GETALL_CHUNK);
    const refs = chunkIds.map((id) => adminDb.collection("conversations").doc(id));
    const snaps = await adminDb.getAll(...refs);
    snaps.forEach((snap) => {
      if (snap.exists) conversationById.set(snap.id, snap.data() || {});
    });
  }

  const FAILURE_STATUSES = new Set(["failed", "undelivered"]);

  const toCancel: { id: string; ref: FirebaseFirestore.DocumentReference; phone: string; ownerUid: string; reason: string }[] = [];
  let checkedNoConversation = 0;
  let looksFine = 0;

  for (const doc of pendingSnap.docs) {
    const data = doc.data() || {};
    const conversationId = String(data.conversationId || "");
    const conversation = conversationId ? conversationById.get(conversationId) : undefined;

    if (!conversation) {
      checkedNoConversation++;
      continue;
    }

    const lastOutboundStatus = String(conversation.lastOutboundStatus || "").toLowerCase();
    const conversationStatus = String(conversation.status || "").toLowerCase();

    const isPermanentFailure =
      FAILURE_STATUSES.has(lastOutboundStatus) || conversationStatus === "delivery_issue";

    if (isPermanentFailure) {
      toCancel.push({
        id: doc.id,
        ref: doc.ref,
        phone: String(data.phone || ""),
        ownerUid: String(data.ownerUid || ""),
        reason: `lastOutboundStatus=${lastOutboundStatus || "(none)"} status=${conversationStatus || "(none)"}`,
      });
    } else {
      looksFine++;
    }
  }

  console.log("=== Result ===");
  console.log(`  pending follow-ups checked:        ${pendingSnap.size}`);
  console.log(`  will cancel (original send failed): ${toCancel.length}`);
  console.log(`  no matching conversation found:     ${checkedNoConversation}`);
  console.log(`  look fine, left alone:              ${looksFine}`);
  console.log("");

  if (toCancel.length > 0) {
    console.log("Follow-ups that would be cancelled:");
    for (const c of toCancel) {
      console.log(`  ${c.id}  phone=${c.phone}  ownerUid=${c.ownerUid}  (${c.reason})`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("DRY RUN - nothing written. Re-run with --apply to actually cancel these.");
    return;
  }

  if (toCancel.length === 0) {
    console.log("Nothing to cancel.");
    return;
  }

  const BATCH_LIMIT = 400;
  let batch = adminDb.batch();
  let opsInBatch = 0;

  for (const c of toCancel) {
    batch.update(c.ref, {
      status: "skipped",
      skippedReason: "original_message_undelivered",
      skippedAt: FieldValue.serverTimestamp(),
    });
    opsInBatch++;
    if (opsInBatch >= BATCH_LIMIT) {
      await batch.commit();
      batch = adminDb.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) {
    await batch.commit();
  }

  console.log(`Done - cancelled ${toCancel.length} follow-up(s) whose original message already failed to deliver.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
