// Backfills a `phoneReversed` field onto existing conversations/{id} docs.
//
// Why: the /replies search box now has an indexed fast path for phone-number
// search (see app/replies/page.tsx). Confirmed via
// tools/audit-conversation-phone-format.ts that 99.96% of conversations
// store `phone` as "+1XXXXXXXXXX", which makes a fast, indexed *prefix*
// query possible - but a prefix query can only match numbers typed from
// the start (the full number, or the start of it). Searching by the last
// 4 digits - a very normal way to look someone up - needs the number
// reversed, so "ends with 2955" becomes "starts with 5592" against a
// reversed copy of the field. Every NEW conversation write already sets
// this field (see reversePhone() in lib/phone.ts, used across
// app/api/send-sms/route.ts, app/api/send-sms/twilio/route.ts,
// app/api/send-sms/twilio/inbound/route.ts, app/api/send-reply/route.ts) -
// this script is a one-time catch-up for every conversation that already
// existed before that change shipped.
//
// Safe to re-run - docs that already have a phoneReversed matching their
// current phone are left untouched.
//
// Usage:
//   npx tsx tools/backfill-phone-reversed.ts            (dry run, default)
//   npx tsx tools/backfill-phone-reversed.ts --apply     (writes for real)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function reversePhone(phone: string): string {
  return String(phone || "").split("").reverse().join("");
}

const PAGE_SIZE = 500;

async function main() {
  const apply = process.argv.includes("--apply");
  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  let scanned = 0;
  let missingOrStale = 0;
  let alreadyCorrect = 0;
  let emptyPhone = 0;
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
    let q = adminDb.collection("conversations").orderBy("__name__").limit(PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() || {};
      const phone = String(data.phone || "").trim();

      if (!phone) {
        emptyPhone++;
        continue;
      }

      const correctReversed = reversePhone(phone);

      if (data.phoneReversed === correctReversed) {
        alreadyCorrect++;
        continue;
      }

      missingOrStale++;

      if (missingOrStale <= 20) {
        console.log(
          `${apply ? "Fixing" : "Would fix"} conversations/${doc.id} (phone="${phone}") - phoneReversed ${data.phoneReversed ? "stale" : "missing"}`
        );
      }

      if (apply) {
        batch.set(doc.ref, { phoneReversed: correctReversed }, { merge: true });
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

  if (missingOrStale > 20) {
    console.log(`... and ${missingOrStale - 20} more (only first 20 shown)`);
  }

  console.log("\nSummary:");
  console.log(`  ${scanned} conversations scanned`);
  console.log(`  ${alreadyCorrect} already had a correct phoneReversed`);
  console.log(`  ${emptyPhone} skipped (empty phone field)`);
  console.log(`  ${missingOrStale} ${apply ? "fixed" : "would be fixed"}`);

  if (!apply && missingOrStale > 0) {
    console.log("\nThis was a dry run. Re-run with --apply to actually write these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
