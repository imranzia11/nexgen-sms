// Read-only lookup to find a user's login email/uid by name (or partial
// name match), for cases like set-sender-email.ts where you need someone's
// actual app login email but only know their name. Prints every user whose
// name contains the search term (case-insensitive) along with their email,
// uid, twilioNumber, and current senderEmail (if any) - nothing is written.
//
// Usage:
//   npx tsx tools/find-user.ts --name=charles

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const search = getArg("name").trim().toLowerCase();

  if (!search) {
    console.error("Usage: npx tsx tools/find-user.ts --name=charles");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb.collection("users").get();

  const matches = snap.docs.filter((d) => {
    const data = d.data() || {};
    const name = String(data.name || "").toLowerCase();
    const email = String(data.email || "").toLowerCase();
    return name.includes(search) || email.includes(search);
  });

  if (matches.length === 0) {
    console.log(`No users found matching "${search}".`);
    process.exit(0);
  }

  console.log(`Found ${matches.length} matching user(s):\n`);

  for (const doc of matches) {
    const data = doc.data() || {};
    console.log(`uid:          ${doc.id}`);
    console.log(`name:         ${data.name || "(none)"}`);
    console.log(`login email:  ${data.email || "(none)"}`);
    console.log(`twilioNumber: ${data.twilioNumber || data.assignedTwilioNumber || "(none)"}`);
    console.log(`senderEmail:  ${data.senderEmail || "(none)"}`);
    console.log(`isActive:     ${data.isActive === true ? "yes" : "no"}`);
    console.log("---");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
