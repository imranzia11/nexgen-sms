// READ-ONLY. Writes nothing, deletes nothing.
//
// Deciding whether it's safe to add a fast, indexed Firestore query for
// phone-number search on /replies (instead of downloading every
// conversation and filtering client-side - see app/replies/page.tsx). An
// indexed range query needs every conversation's `phone` field to be in
// one single, predictable format (e.g. always "+1XXXXXXXXXX"). Today,
// `phone` is written via toE164() (lib/phone.ts), which just strips
// non-digit characters and prepends "+" - it does NOT force a US country
// code onto a bare 10-digit number. So a lead uploaded as "9122300998"
// ends up stored as "+9122300998" (10 digits), while a lead uploaded as
// "19122300998" ends up as "+19122300998" (11 digits) - two different
// strings for what might be the same kind of US number, depending on
// nothing but how the original lead file happened to be formatted.
//
// This script buckets every conversation's `phone` value by shape, across
// every account, so we know how big that inconsistency actually is before
// building anything that assumes one canonical format.
//
// Usage:
//   npx tsx tools/audit-conversation-phone-format.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BUCKETS = {
  usWithCountryCode: /^\+1\d{10}$/, // +1XXXXXXXXXX - the canonical shape
  usMissingCountryCode: /^\+\d{10}$/, // +XXXXXXXXXX - 10 digits, no leading 1
  plusOther: /^\+\d+$/, // any other +digits length (intl, malformed, etc.)
  noPlusPrefix: /^\d+$/, // digits only, no + at all (shouldn't happen via toE164, but check)
  empty: /^$/,
};

function classify(phone: string): keyof typeof BUCKETS | "other" {
  for (const [name, pattern] of Object.entries(BUCKETS)) {
    if (pattern.test(phone)) return name as keyof typeof BUCKETS;
  }
  return "other";
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb.collection("conversations").get();

  const counts: Record<string, number> = {};
  const examples: Record<string, string[]> = {};

  for (const d of snap.docs) {
    const data = d.data();
    const phone = String(data.phone || "").trim();
    const bucket = classify(phone);

    counts[bucket] = (counts[bucket] || 0) + 1;
    if (!examples[bucket]) examples[bucket] = [];
    if (examples[bucket].length < 5) {
      examples[bucket].push(`${d.id} -> phone="${phone}" (ownerUid=${data.ownerUid || "?"})`);
    }
  }

  console.log(`Total conversations scanned: ${snap.docs.length}\n`);

  for (const [bucket, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`${bucket}: ${count}`);
    (examples[bucket] || []).forEach((ex) => console.log(`    ${ex}`));
    console.log("");
  }

  const canonical = counts["usWithCountryCode"] || 0;
  const total = snap.docs.length || 1;
  const canonicalPct = ((canonical / total) * 100).toFixed(1);

  console.log(`${canonicalPct}% of conversations are in the canonical +1XXXXXXXXXX shape.`);
  console.log("Done. Nothing was written or deleted.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
