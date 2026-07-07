// Read-only audit: finds any Twilio number assigned to more than one user
// in the `users` collection. Run with: npx tsx tools/audit-duplicate-numbers.ts
//
// This is exactly the scenario that broke ownership resolution — two users
// sharing the same twilioNumber/assignedTwilioNumber means Twilio and the
// inbound webhook can no longer tell them apart.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  // Dynamic import, done deliberately: static imports are evaluated before
  // this file's own body runs, which would initialize firebase-admin before
  // dotenv.config() above ever executes. A dynamic import() inside main()
  // defers loading until this line actually runs, after env vars are set.
  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb.collection("users").get();

  const byNumber = new Map<
    string,
    Array<{ uid: string; email: string; name: string; field: string; isActive: boolean }>
  >();

  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const email = String(data.email || "");
    const name = String(data.name || "");
    const isActive = data.isActive === true;

    const candidates: Array<[string, string]> = [
      ["twilioNumber", String(data.twilioNumber || "")],
      ["assignedTwilioNumber", String(data.assignedTwilioNumber || "")],
    ];

    for (const [field, raw] of candidates) {
      const number = toE164(raw);
      if (!number) continue;

      const list = byNumber.get(number) || [];
      list.push({ uid: doc.id, email, name, field, isActive });
      byNumber.set(number, list);
    }
  });

  console.log(`Scanned ${snap.size} user docs.\n`);

  let conflicts = 0;

  for (const [number, entries] of byNumber.entries()) {
    const distinctUids = new Set(entries.map((e) => e.uid));
    if (distinctUids.size <= 1) continue;

    conflicts++;
    console.log(`CONFLICT: ${number} is claimed by ${distinctUids.size} different users:`);
    entries.forEach((e) => {
      console.log(
        `  - uid=${e.uid} email=${e.email || "(none)"} name=${e.name || "(none)"} via=${e.field} active=${e.isActive}`
      );
    });
    console.log("");
  }

  if (conflicts === 0) {
    console.log("No duplicate number assignments found across the users collection.");
  } else {
    console.log(`Found ${conflicts} number(s) assigned to more than one user.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
  });
