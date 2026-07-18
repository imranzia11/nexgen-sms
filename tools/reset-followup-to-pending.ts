// WRITES to Firestore. Resets a specific followUps doc (by its document
// ID) back to status "pending" with a fresh dueAt, so the next scheduler
// tick picks it up and actually sends it - used for docs that were
// previously skipped under the old hasReply logic (now removed from
// app/api/cron/send-followups/route.ts), which is a terminal status the
// cron will never automatically retry on its own.
//
// Usage:
//   npx tsx tools/reset-followup-to-pending.ts <docId> [minutesFromNow]
// Example:
//   npx tsx tools/reset-followup-to-pending.ts 06qseBVgKIrseKpXIsSi 2

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const docId = process.argv[2];
  const minutesFromNow = Number(process.argv[3] || 2);

  if (!docId) {
    console.error(
      "Usage: npx tsx tools/reset-followup-to-pending.ts <docId> [minutesFromNow]"
    );
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  const ref = adminDb.collection("followUps").doc(docId);
  const snap = await ref.get();

  if (!snap.exists) {
    console.log(`No followUps doc found with id ${docId}.`);
    return;
  }

  const data = snap.data() || {};
  console.log(`Found doc: phone=${data.phone}, ownerUid=${data.ownerUid}, current status=${data.status}`);

  const newDueAt = new Date(Date.now() + minutesFromNow * 60 * 1000);

  await ref.update({
    status: "pending",
    dueAt: newDueAt,
    skippedReason: FieldValue.delete(),
  });

  console.log(`Reset to pending. New dueAt: ${newDueAt.toISOString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
