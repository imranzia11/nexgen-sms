// READ-ONLY. Searches one owner's conversations for a phone number, matching
// by digit substring so exact formatting (with/without +1, country code,
// etc.) doesn't matter. Useful when you're not sure the number was stored in
// clean E.164 form.
//
// Usage:
//   npx tsx tools/find-conversation-by-phone.ts <ownerUid> <phoneOrDigits>
// Example:
//   npx tsx tools/find-conversation-by-phone.ts BaEiz6eiIzTJJJwqkYW7jCJLClt1 1888461272

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function digitsOnly(value: string) {
  return String(value || "").replace(/\D/g, "");
}

async function main() {
  const ownerUid = process.argv[2];
  const rawPhone = process.argv[3];

  if (!ownerUid || !rawPhone) {
    console.error(
      "Usage: npx tsx tools/find-conversation-by-phone.ts <ownerUid> <phoneOrDigits>"
    );
    process.exit(1);
  }

  const searchDigits = digitsOnly(rawPhone);
  // Also try without a leading "1" and with one, in case the target's own
  // digits are stored either way.
  const variants = new Set([
    searchDigits,
    searchDigits.startsWith("1") ? searchDigits.slice(1) : `1${searchDigits}`,
  ]);

  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Searching conversations for ownerUid=${ownerUid}, matching digits like: ${[...variants].join(" / ")}\n`);

  const snap = await adminDb
    .collection("conversations")
    .where("ownerUid", "==", ownerUid)
    .get();

  console.log(`Scanning ${snap.size} conversation(s)...\n`);

  let found = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const phoneFields = [data.phone, data.customerPhone, data.to, data.contactPhone]
      .filter(Boolean)
      .map((p) => digitsOnly(String(p)));

    const matches = phoneFields.some((p) =>
      [...variants].some((v) => v && p.includes(v))
    );

    if (matches) {
      found++;
      console.log(`MATCH: conversations/${doc.id}`);
      console.log(`  phone: ${data.phone}`);
      console.log(`  name: ${data.name || "(none)"}`);
      console.log(`  hasReply: ${data.hasReply}, lastDirection: ${data.lastDirection}, blocked: ${data.blocked}`);
      console.log(`  lastMessage: ${JSON.stringify(String(data.lastMessage || "").slice(0, 80))}`);
      console.log("");
    }
  }

  if (found === 0) {
    console.log("No conversation found matching that number for this owner.");
    console.log("(Double check the ownerUid is correct, or the number might be under a different account.)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
