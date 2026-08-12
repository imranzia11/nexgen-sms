// Cancels every pending follow-up for one specific account - used here to
// clear out Charles's pending follow-ups (scheduled off the batch of
// messages that failed with error 21606 due to a malformed twilioNumber)
// before resending those originals and re-scheduling follow-ups fresh.
//
// Marks matching docs `status: "cancelled"` (never deletes) - same
// never-delete convention as every other status change on this collection
// (see app/api/cron/send-followups/route.ts's "skipped" pattern), so
// there's still a record of what was pending and why it stopped.
//
// Usage:
//   npx tsx tools/cancel-followups-for-account.ts --email=charles@nexgen.com            (dry run)
//   npx tsx tools/cancel-followups-for-account.ts --email=charles@nexgen.com --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const apply = process.argv.includes("--apply");
  const emailArg = process.argv.find((a) => a.startsWith("--email="));
  const email = emailArg ? emailArg.split("=")[1].trim().toLowerCase() : "";

  if (!email) {
    console.error("Usage: npx tsx tools/cancel-followups-for-account.ts --email=someone@example.com [--apply]");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  const userSnap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
  if (userSnap.empty) {
    console.error(`No user found with email ${email}.`);
    process.exit(1);
  }

  const ownerUid = userSnap.docs[0].id;
  const userData = userSnap.docs[0].data() || {};

  console.log(`Account: ${userData.name || email} (${ownerUid})`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  const pendingSnap = await adminDb
    .collection("followUps")
    .where("ownerUid", "==", ownerUid)
    .where("status", "==", "pending")
    .get();

  if (pendingSnap.empty) {
    console.log("No pending follow-ups found for this account.");
    return;
  }

  console.log(`Found ${pendingSnap.size} pending follow-up(s).\n`);

  let batch = adminDb.batch();
  let batchCount = 0;

  async function flushBatch() {
    if (batchCount === 0) return;
    if (apply) await batch.commit();
    batch = adminDb.batch();
    batchCount = 0;
  }

  for (const doc of pendingSnap.docs) {
    const data = doc.data() || {};
    console.log(`  ${apply ? "Cancelling" : "Would cancel"} ${doc.id} - phone=${data.phone || "?"}, campaign="${data.campaignName || ""}"`);

    if (apply) {
      batch.update(doc.ref, {
        status: "cancelled",
        skippedReason: "manual_cancel_before_resend",
        cancelledAt: FieldValue.serverTimestamp(),
      });
      batchCount++;
      if (batchCount >= 450) await flushBatch();
    }
  }

  await flushBatch();

  console.log("");
  if (!apply) {
    console.log("DRY RUN - nothing changed. Re-run with --apply to actually cancel these.");
  } else {
    console.log(`Done - cancelled ${pendingSnap.size} follow-up(s).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
