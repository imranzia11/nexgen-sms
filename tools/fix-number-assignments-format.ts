// Finds numberAssignments docs whose ID is NOT clean E.164 (missing "+",
// stray whitespace, etc.), and migrates each one to a correctly-formatted
// doc ID — without ever destroying the ownerUid mapping.
//
// Also cross-checks users.twilioNumber / users.assignedTwilioNumber for the
// same kind of formatting problem (e.g. Abe's "+12314272027 " trailing
// space) and reports them, since that's a second copy of the same number
// that must also be clean for lookups to be consistent.
//
// Dry-run by default. Add --apply to actually write changes.
//
// Usage:
//   npx tsx tools/fix-number-assignments-format.ts
//   npx tsx tools/fix-number-assignments-format.ts --apply

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

  console.log(apply ? "APPLY MODE — writes will happen.\n" : "DRY RUN — no writes will happen. Add --apply to write.\n");

  // --- Part 1: numberAssignments doc ID formatting ---
  console.log("=== numberAssignments doc ID check ===");
  const assignmentsSnap = await adminDb.collection("numberAssignments").get();

  let assignmentIssues = 0;

  for (const doc of assignmentsSnap.docs) {
    const id = doc.id;
    const clean = toE164(id);

    if (clean === id) continue; // already correctly formatted

    assignmentIssues++;
    const data = doc.data() || {};
    console.log(`\nBAD ID: numberAssignments/${id}  ->  should be numberAssignments/${clean}`);
    console.log(`  data: ${JSON.stringify(data)}`);

    if (!clean) {
      console.log("  SKIP: could not normalize this ID at all, needs manual review.");
      continue;
    }

    const targetRef = adminDb.collection("numberAssignments").doc(clean);
    const targetSnap = await targetRef.get();

    if (targetSnap.exists) {
      const targetData = targetSnap.data() || {};
      if (targetData.ownerUid && data.ownerUid && targetData.ownerUid !== data.ownerUid) {
        console.log(
          `  CONFLICT: numberAssignments/${clean} already exists with a DIFFERENT ownerUid (${targetData.ownerUid} vs ${data.ownerUid}). Not touching either doc — needs manual review.`
        );
        continue;
      }
      console.log(`  Target numberAssignments/${clean} already exists with matching/compatible data.`);
      if (apply) {
        await doc.ref.delete();
        console.log(`  Deleted the malformed duplicate numberAssignments/${id}.`);
      } else {
        console.log(`  Would delete the malformed duplicate numberAssignments/${id}.`);
      }
      continue;
    }

    if (apply) {
      await targetRef.create(data);
      await doc.ref.delete();
      console.log(`  Migrated: created numberAssignments/${clean}, deleted numberAssignments/${id}.`);
    } else {
      console.log(`  Would create numberAssignments/${clean} with same data, then delete numberAssignments/${id}.`);
    }
  }

  if (assignmentIssues === 0) {
    console.log("No formatting issues found in numberAssignments doc IDs.");
  }

  // --- Part 2: users.twilioNumber / assignedTwilioNumber formatting ---
  console.log("\n=== users.twilioNumber / assignedTwilioNumber field check ===");
  const usersSnap = await adminDb.collection("users").get();
  let userFieldIssues = 0;

  for (const doc of usersSnap.docs) {
    const data = doc.data() || {};
    const email = String(data.email || "(no email)");

    for (const field of ["twilioNumber", "assignedTwilioNumber"]) {
      const raw = data[field];
      if (raw === undefined || raw === null || raw === "") continue;

      const rawStr = String(raw);
      const clean = toE164(rawStr);

      if (rawStr === clean) continue;

      userFieldIssues++;
      console.log(
        `\nBAD FIELD: users/${doc.id} (${email}).${field} = "${rawStr}" (length ${rawStr.length})  ->  should be "${clean}"`
      );

      if (apply) {
        await doc.ref.update({ [field]: clean });
        console.log(`  Fixed: set ${field} = "${clean}"`);
      } else {
        console.log(`  Would set ${field} = "${clean}"`);
      }
    }
  }

  if (userFieldIssues === 0) {
    console.log("No formatting issues found in users.twilioNumber / assignedTwilioNumber.");
  }

  console.log(`\nDone. ${apply ? "Changes applied." : "Dry run only — rerun with --apply to write."}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fix script failed:", err);
    process.exit(1);
  });
