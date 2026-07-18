// READ-ONLY. Lists all user accounts so we can check whether the client
// might have sent from a second/different login than the uid we've been
// checking (8JHmWXe9GldYdtjgvX4KBcWh1423 / abe@nexgen.io).
//
// Usage:
//   npx tsx tools/list-related-accounts.ts [emailOrNameFilter]

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const filter = (process.argv[2] || "").toLowerCase();
  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb.collection("users").get();

  console.log(`Total user accounts: ${snap.size}\n`);

  snap.docs.forEach((d) => {
    const u = d.data() || {};
    const email = String(u.email || "").toLowerCase();
    const name = String(u.name || "").toLowerCase();

    if (filter && !email.includes(filter) && !name.includes(filter)) return;

    console.log(`--- ${d.id} ---`);
    console.log(`  email:        ${u.email || "(none)"}`);
    console.log(`  name:         ${u.name || "(none)"}`);
    console.log(`  isActive:     ${u.isActive}`);
    console.log(`  twilioNumber: ${u.twilioNumber || u.assignedTwilioNumber || "(none)"}`);
    console.log("");
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
