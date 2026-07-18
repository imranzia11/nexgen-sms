// WRITES to Firestore. Moves a specific pending follow-up's dueAt to
// "now + N minutes" so you can watch the Cloud Scheduler job actually pick
// it up and send it within the scheduler's next 15-minute tick, instead of
// waiting hours for its real due time - purely for verifying the pipeline
// end to end.
//
// Usage:
//   npx tsx tools/set-followup-due-soon.ts <ownerUid> <phone> [minutesFromNow]
// Example:
//   npx tsx tools/set-followup-due-soon.ts SKmaVTN8TjeTayQ9FiuStmNiNLE2 +19145674441 2

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const ownerUid = process.argv[2];
  const phone = process.argv[3];
  const minutesFromNow = Number(process.argv[4] || 2);

  if (!ownerUid || !phone) {
    console.error(
      "Usage: npx tsx tools/set-followup-due-soon.ts <ownerUid> <phone> [minutesFromNow]"
    );
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb
    .collection("followUps")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .where("status", "==", "pending")
    .get();

  if (snap.empty) {
    console.log("No pending follow-up found for that ownerUid + phone.");
    return;
  }

  const newDueAt = new Date(Date.now() + minutesFromNow * 60 * 1000);

  for (const doc of snap.docs) {
    await doc.ref.update({ dueAt: newDueAt });
    console.log(`Updated ${doc.id}: dueAt -> ${newDueAt.toISOString()}`);
  }

  console.log(
    `\nDone. The scheduler runs every 15 minutes, so this will be picked up on its next tick at or after ${newDueAt.toISOString()}.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
