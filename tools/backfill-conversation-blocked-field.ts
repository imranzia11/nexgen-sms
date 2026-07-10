// Backfills a missing `blocked` field on conversations/{id} docs.
//
// Why this is needed: the inbound webhook and send-sms/route.ts have always
// written `blocked: true/false` on every conversation they touch, but
// send-reply/route.ts never did until today's fix. Any conversation that
// was ONLY ever touched by a manual reply (never a bulk send, never an
// inbound message) has `blocked` completely missing rather than `false`.
// That's a problem because the plan is to switch the /replies stat counts
// to Firestore's server-side count queries filtered on `blocked == false`
// - a query like that silently skips any doc where the field is missing
// entirely, which would make historical conversations vanish from every
// count without any error. This script finds those docs and sets
// `blocked: false` on them (safe default: if neither the inbound webhook
// nor a bulk send ever marked it blocked, it isn't).
//
// Firestore has no native "field does not exist" query, so this scans
// every conversation document in pages and checks in JS. Safe to re-run -
// docs that already have the field (true or false) are left untouched.
//
// Usage:
//   npx tsx tools/backfill-conversation-blocked-field.ts            (dry run, default)
//   npx tsx tools/backfill-conversation-blocked-field.ts --apply     (writes for real)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const PAGE_SIZE = 500;

async function main() {
  const apply = process.argv.includes("--apply");
  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  let scanned = 0;
  let missing = 0;
  let alreadyHadField = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let batch = adminDb.batch();
  let batchCount = 0;

  async function flushBatch() {
    if (batchCount === 0) return;
    if (apply) {
      await batch.commit();
    }
    batch = adminDb.batch();
    batchCount = 0;
  }

  for (;;) {
    let q = adminDb
      .collection("conversations")
      .orderBy("__name__")
      .limit(PAGE_SIZE);

    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() || {};

      if (data.blocked === true || data.blocked === false) {
        alreadyHadField++;
        continue;
      }

      missing++;

      if (missing <= 20) {
        console.log(
          `${apply ? "Fixing" : "Would fix"} conversations/${doc.id} (ownerUid=${data.ownerUid || "?"}, phone=${data.phone || "?"}) - blocked field missing`
        );
      }

      if (apply) {
        batch.set(doc.ref, { blocked: false }, { merge: true });
        batchCount++;

        if (batchCount >= 450) {
          await flushBatch();
        }
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];

    if (snap.docs.length < PAGE_SIZE) break;
  }

  await flushBatch();

  if (missing > 20) {
    console.log(`... and ${missing - 20} more (only first 20 shown)`);
  }

  console.log("\nSummary:");
  console.log(`  ${scanned} conversations scanned`);
  console.log(`  ${alreadyHadField} already had the blocked field`);
  console.log(`  ${missing} ${apply ? "fixed" : "would be fixed"} (set to blocked: false)`);

  if (!apply && missing > 0) {
    console.log("\nThis was a dry run. Re-run with --apply to actually write these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
