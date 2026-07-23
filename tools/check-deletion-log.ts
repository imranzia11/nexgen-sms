// READ-ONLY. Checks the permanent, append-only deletionLogs audit trail
// (see lib/deletionLog.ts - Firestore rules only allow "create" on this
// collection, no update/delete, so it's a trustworthy record) for whether
// a specific phone number's conversation was ever manually deleted, by
// whom, and when.
//
// Usage:
//   npx tsx tools/check-deletion-log.ts <phone>
// Example:
//   npx tsx tools/check-deletion-log.ts +18032420778

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function fmt(value: any): string {
  if (!value) return "(none)";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

async function main() {
  const rawPhone = process.argv[2];
  if (!rawPhone) {
    console.error("Usage: npx tsx tools/check-deletion-log.ts <phone>");
    process.exit(1);
  }
  const phone = toE164(rawPhone);
  const last10 = phone.replace(/\D/g, "").slice(-10);

  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`\nChecking deletionLogs for phone: ${phone}`);
  console.log("=".repeat(60));

  // Exact match first
  const exactSnap = await adminDb
    .collection("deletionLogs")
    .where("phone", "==", phone)
    .get();

  console.log(`Exact phone match: ${exactSnap.size}`);
  exactSnap.docs.forEach((d) => {
    const data = d.data();
    console.log(`  - id=${d.id}`);
    console.log(`    type: ${data.type}`);
    console.log(`    ownerUid: ${data.ownerUid}`);
    console.log(`    ownerEmail: ${data.ownerEmail}`);
    console.log(`    name: ${data.name}`);
    console.log(`    source: ${data.source}`);
    console.log(`    deletedAt: ${fmt(data.deletedAt)}`);
  });

  // Fallback: scan everything and match on last-10-digits, in case the
  // logged phone field diverges in format from what we're searching for.
  const allSnap = await adminDb.collection("deletionLogs").get();
  console.log(`\nTotal deletionLogs entries in the whole platform: ${allSnap.size}`);

  const looseMatches = allSnap.docs.filter((d) => {
    const data = d.data();
    const digits = String(data.phone || "").replace(/\D/g, "");
    return last10.length === 10 && digits.endsWith(last10);
  });

  console.log(`Loose (last-10-digit) matches: ${looseMatches.length}`);
  looseMatches.forEach((d) => {
    const data = d.data();
    console.log(`  - id=${d.id}`);
    console.log(`    phone: ${data.phone}`);
    console.log(`    type: ${data.type}`);
    console.log(`    ownerUid: ${data.ownerUid}`);
    console.log(`    ownerEmail: ${data.ownerEmail}`);
    console.log(`    name: ${data.name}`);
    console.log(`    source: ${data.source}`);
    console.log(`    deletedAt: ${fmt(data.deletedAt)}`);
  });

  console.log("\n" + "=".repeat(60));
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
