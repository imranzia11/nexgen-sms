// Brings back "Imported Files" entries that were deleted from the dashboard.
//
// Deleting a file on the dashboard removes only the uploads/{id} record - the
// leads stay in Firestore, still tagged with that upload id. This finds lead
// groups whose upload record no longer exists and re-creates the record
// (same id, file name taken from the leads), so the file and its leads show
// up again. It also prints the account's recent deletion log so you can see
// exactly what was deleted and when.
//
// Usage:
//   npx tsx tools/restore-upload-records.ts --email=jon@nexgenmerchant.io          (dry run)
//   npx tsx tools/restore-upload-records.ts --email=jon@nexgenmerchant.io --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const email = getArg("email").trim().toLowerCase();
  if (!email) {
    console.error("Usage: --email=user@example.com [--apply]");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { getAuth } = await import("firebase-admin/auth");

  let uid = "";
  try {
    uid = (await getAuth().getUserByEmail(email)).uid;
  } catch {
    console.error(`No login exists in Firebase Authentication for ${email}.`);
    process.exit(1);
  }
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Account: ${email} (uid ${uid})\n`);

  // Recent deletions recorded by the app.
  const logs = await adminDb.collection("deletionLogs").where("ownerUid", "==", uid).get();
  const recent = logs.docs
    .map((d) => d.data())
    .sort((a, b) => (b.deletedAt?.toMillis?.() || 0) - (a.deletedAt?.toMillis?.() || 0))
    .slice(0, 15);
  console.log("Most recent deletions logged for this account:");
  if (recent.length === 0) console.log("  (none)");
  recent.forEach((r) => {
    const when = r.deletedAt?.toDate?.().toISOString?.() || "?";
    console.log(`  ${when}  ${r.type}  ${r.fileName || r.phone || r.name || ""}  [${r.source}]`);
  });

  // Lead groups by upload id.
  const leadsSnap = await adminDb
    .collection("leads")
    .where("ownerUid", "==", uid)
    .select("uploadId", "sourceFileName", "status", "createdAt")
    .get();

  type Group = { file: string; total: number; valid: number; firstAt: any };
  const groups = new Map<string, Group>();
  for (const d of leadsSnap.docs) {
    const uploadId = String(d.get("uploadId") || "");
    if (!uploadId) continue;
    const g = groups.get(uploadId) || {
      file: String(d.get("sourceFileName") || "Restored file"),
      total: 0,
      valid: 0,
      firstAt: d.get("createdAt") || null,
    };
    g.total += 1;
    if (String(d.get("status") || "").toLowerCase() === "verified") g.valid += 1;
    groups.set(uploadId, g);
  }

  console.log(`\n${groups.size} upload id(s) found on leads. Checking which records are missing...\n`);

  let missing = 0;
  for (const [uploadId, g] of groups) {
    const exists = (await adminDb.collection("uploads").doc(uploadId).get()).exists;
    if (exists) continue;
    missing += 1;
    console.log(`MISSING record ${uploadId}: "${g.file}" - ${g.total} leads (${g.valid} verified)`);
    if (apply) {
      await adminDb.collection("uploads").doc(uploadId).set({
        fileName: g.file,
        uploadedBy: uid,
        ownerUid: uid,
        uploadedByName: "",
        phoneColumn: "",
        totalRows: g.total,
        validPhoneRows: g.valid,
        status: "imported",
        restoredAt: new Date(),
        createdAt: g.firstAt || new Date(),
      });
    }
  }

  if (missing === 0) {
    console.log("No missing upload records - every lead group still has its file record.");
    console.log(
      "If a file is still gone, its leads were deleted too and can't be rebuilt here - re-upload the CSV."
    );
  } else if (!apply) {
    console.log(`\n${missing} record(s) would be restored. Re-run with --apply.`);
  } else {
    console.log(`\nRestored ${missing} file record(s). Refresh the dashboard.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
