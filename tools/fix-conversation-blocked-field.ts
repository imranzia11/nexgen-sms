// CORRECTS a mistake made by the earlier tools/backfill-conversation-blocked-field.ts
// script. That script set `blocked: false` on every conversation missing the
// field, without checking whether the number was actually blacklisted. Some
// conversations predate the `blocked` field entirely - including customers
// who texted STOP a long time ago. A STOP reply is still an inbound message
// (hasReply: true, lastDirection: "inbound"), which is exactly the shape of
// a "Customer Replied" conversation - so the blanket `false` default
// silently pulled a bunch of actually-opted-out conversations back into
// that count.
//
// This script is the correct version: it loads every blacklisted_numbers
// entry (the real source of truth for who's opted out) into memory, then
// walks every conversation and sets `blocked` to what it should ACTUALLY be
// based on that list - fixing both the conversations the previous script
// touched and any others that happen to be wrong.
//
// Conversations with no ownerUid (the ~15k orphaned legacy docs found
// earlier) are skipped - they're invisible to every query in the app
// regardless of this field, so there's nothing to fix there.
//
// Usage:
//   npx tsx tools/fix-conversation-blocked-field.ts            (dry run, default)
//   npx tsx tools/fix-conversation-blocked-field.ts --apply     (writes for real)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const PAGE_SIZE = 500;

function phoneKey(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);
  console.log("Loading blacklisted_numbers (source of truth)...");

  const blacklistSnap = await adminDb.collection("blacklisted_numbers").get();
  const blockedSet = new Set<string>();

  blacklistSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (String(data.status || "").toLowerCase() === "blocked") {
      const ownerUid = String(data.ownerUid || "");
      const phone = phoneKey(data.phone);
      if (ownerUid && phone) {
        blockedSet.add(`${ownerUid}|${phone}`);
      }
    }
  });

  console.log(`Loaded ${blockedSet.size} blocked owner+phone pairs.\n`);

  let scanned = 0;
  let noOwner = 0;
  let alreadyCorrect = 0;
  let fixedToTrue = 0;
  let fixedToFalse = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let batch = adminDb.batch();
  let batchCount = 0;
  let shownExamples = 0;

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
      const ownerUid = String(data.ownerUid || "");
      const phone = phoneKey(data.phone);

      if (!ownerUid || !phone) {
        noOwner++;
        continue;
      }

      const shouldBeBlocked = blockedSet.has(`${ownerUid}|${phone}`);
      const currentlyBlocked = data.blocked === true;

      if (currentlyBlocked === shouldBeBlocked) {
        alreadyCorrect++;
        continue;
      }

      if (shownExamples < 20) {
        console.log(
          `${apply ? "Fixing" : "Would fix"} conversations/${doc.id} (ownerUid=${ownerUid}, phone=${phone}): blocked ${data.blocked} -> ${shouldBeBlocked}`
        );
        shownExamples++;
      }

      if (shouldBeBlocked) {
        fixedToTrue++;
      } else {
        fixedToFalse++;
      }

      if (apply) {
        batch.set(doc.ref, { blocked: shouldBeBlocked }, { merge: true });
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

  const totalFixed = fixedToTrue + fixedToFalse;
  if (totalFixed > 20) {
    console.log(`... and ${totalFixed - 20} more (only first 20 shown)`);
  }

  console.log("\nSummary:");
  console.log(`  ${scanned} conversations scanned`);
  console.log(`  ${noOwner} skipped (no ownerUid/phone - orphaned legacy docs)`);
  console.log(`  ${alreadyCorrect} already correct`);
  console.log(`  ${fixedToTrue} ${apply ? "corrected to blocked: true" : "would be corrected to blocked: true"} (actually opted out)`);
  console.log(`  ${fixedToFalse} ${apply ? "corrected to blocked: false" : "would be corrected to blocked: false"}`);

  if (!apply && totalFixed > 0) {
    console.log("\nThis was a dry run. Re-run with --apply to actually write these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fix failed:", err);
    process.exit(1);
  });
