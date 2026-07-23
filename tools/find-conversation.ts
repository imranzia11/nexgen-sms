// READ-ONLY. One-off lookup to find exactly where a specific customer
// conversation lives and how it's stored - built to resolve the
// "+18032420778 unfindable by every server-side lookup" investigation.
// Tries every ID/field scheme this codebase has ever used:
//   1. Direct doc ID `${ownerUid}_${phone}` (current scheme)
//   2. Direct doc ID `${phone}` alone (legacy scheme - confirmed to exist
//      for at least one other conversation, "Efrin"/+12012308292, found
//      live in Firebase Console)
//   3. where("phone","==",phone) across the whole conversations collection
//   4. where("ownerUid","==",ownerUid) - full account dump, matched in
//      memory on last-10-digits, to catch any other format entirely
//
// Usage:
//   npx tsx tools/find-conversation.ts <phone> [ownerUid]
// Example:
//   npx tsx tools/find-conversation.ts +18032420778 8JHmWXe9GldYdtjgvX4KBcWh1423

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return toE164(phone).replace(/[^\d+]/g, "");
}

async function main() {
  const rawPhone = process.argv[2];
  const ownerUid = process.argv[3] || "";

  if (!rawPhone) {
    console.error("Usage: npx tsx tools/find-conversation.ts <phone> [ownerUid]");
    process.exit(1);
  }

  const phone = toE164(rawPhone);
  const docIdSuffix = phoneDocId(phone);

  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`\nLooking up phone: ${phone}`);
  if (ownerUid) console.log(`Scoped to ownerUid: ${ownerUid}`);
  console.log("=".repeat(60));

  // 1. Direct ID: ${ownerUid}_${phone}
  if (ownerUid) {
    const id1 = `${ownerUid}_${docIdSuffix}`;
    const snap1 = await adminDb.collection("conversations").doc(id1).get();
    console.log(`\n[1] doc("conversations/${id1}")`);
    console.log(`    exists: ${snap1.exists}`);
    if (snap1.exists) console.log("    data:", JSON.stringify(snap1.data(), null, 2));
  }

  // 2. Direct ID: bare phone number (legacy scheme)
  const snap2 = await adminDb.collection("conversations").doc(phone).get();
  console.log(`\n[2] doc("conversations/${phone}")  <- legacy bare-phone ID scheme`);
  console.log(`    exists: ${snap2.exists}`);
  if (snap2.exists) console.log("    data:", JSON.stringify(snap2.data(), null, 2));

  // 3. where("phone","==",phone) - global, no ownerUid filter
  const q3 = await adminDb.collection("conversations").where("phone", "==", phone).get();
  console.log(`\n[3] where("phone","==","${phone}") - global`);
  console.log(`    matches: ${q3.size}`);
  q3.docs.forEach((d) => {
    console.log(`    - id="${d.id}" ownerUid="${d.data().ownerUid}"`);
  });

  // 4. Full account dump (only if ownerUid given) - last resort, matches
  // on last-10-digits so it survives any formatting divergence.
  if (ownerUid) {
    const last10 = phone.replace(/\D/g, "").slice(-10);
    const q4 = await adminDb.collection("conversations").where("ownerUid", "==", ownerUid).get();
    console.log(`\n[4] Full scan of ownerUid="${ownerUid}"'s conversations`);
    console.log(`    total docs for this account: ${q4.size}`);

    const matches = q4.docs.filter((d) => {
      const data = d.data() || {};
      const storedPhoneDigits = String(data.phone || "").replace(/\D/g, "");
      const idDigits = d.id.replace(/\D/g, "");
      return (
        (last10.length === 10 && storedPhoneDigits.endsWith(last10)) ||
        (last10.length === 10 && idDigits.endsWith(last10))
      );
    });

    console.log(`    last-10-digit matches: ${matches.length}`);
    matches.forEach((d) => {
      console.log(`    - id="${d.id}"`);
      console.log("      data:", JSON.stringify(d.data(), null, 2));
    });
  }

  console.log("\n" + "=".repeat(60));
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
