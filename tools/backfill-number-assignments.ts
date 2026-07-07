// Populates numberAssignments/{e164} for every active user's current
// number, so the inbound webhook's fast-path lookup (see
// app/api/send-sms/twilio/inbound/route.ts) has data to read.
//
// Safe to re-run: uses create() (never overwrite/merge), so it can never
// clobber an existing assignment. If a number is already claimed by a
// DIFFERENT uid than the one currently on that user's doc, it's reported
// as a conflict and skipped rather than silently overwritten — that case
// needs a human decision, not an automated one.
//
// Usage:
//   npx tsx tools/backfill-number-assignments.ts            (dry run, default)
//   npx tsx tools/backfill-number-assignments.ts --apply     (writes for real)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { adminDb } = await import("../lib/firebaseAdmin");

  const usersSnap = await adminDb.collection("users").get();
  console.log(`Scanned ${usersSnap.size} user docs. Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  let created = 0;
  let alreadyCorrect = 0;
  let conflicts = 0;
  let skippedNoNumber = 0;

  for (const doc of usersSnap.docs) {
    const uid = doc.id;
    const data = doc.data() || {};
    const number = toE164(String(data.twilioNumber || data.assignedTwilioNumber || ""));

    if (!number) {
      skippedNoNumber++;
      continue;
    }

    const assignmentRef = adminDb.collection("numberAssignments").doc(number);
    const existing = await assignmentRef.get();

    if (existing.exists) {
      const existingOwner = String(existing.data()?.ownerUid || "");

      if (existingOwner === uid) {
        alreadyCorrect++;
        continue;
      }

      conflicts++;
      console.log(
        `CONFLICT: ${number} already assigned to uid=${existingOwner}, but user doc uid=${uid} ` +
          `(email=${data.email || "?"}) also claims it. Skipping — resolve manually.`
      );
      continue;
    }

    console.log(`${apply ? "Creating" : "Would create"} numberAssignments/${number} -> uid=${uid} (email=${data.email || "?"})`);

    if (apply) {
      await assignmentRef.create({
        ownerUid: uid,
        phoneNumberSid: String(data.phoneNumberSid || ""),
        createdAt: new Date(),
      });
    }

    created++;
  }

  console.log("\nSummary:");
  console.log(`  ${created} ${apply ? "created" : "would be created"}`);
  console.log(`  ${alreadyCorrect} already correct`);
  console.log(`  ${conflicts} conflicts needing manual review`);
  console.log(`  ${skippedNoNumber} users skipped (no number on file)`);

  if (!apply && created > 0) {
    console.log("\nThis was a dry run. Re-run with --apply to actually write these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
