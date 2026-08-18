// Assigns a sending email identity (senderEmail/senderName) to one user's
// account, mirroring how a Twilio number gets assigned via twilioNumber on
// the same users/{uid} doc. This is the admin-side step referenced by
// app/api/email-marketing/verify-sender/route.ts - a user cannot unlock the
// Email Marketing page for an account that hasn't had a senderEmail set here
// first.
//
// senderEmail must be an address you've actually authenticated in SendGrid
// (Single Sender Verification at minimum; Domain Authentication for real
// deliverability - see lib/emailSend.ts) - this script does not verify that,
// it only writes the assignment.
//
// Usage:
//   npx tsx tools/set-sender-email.ts --email=charles@nexgen.com --senderEmail=charles@nexgenmerchant.io --senderName="Charles @ Nexgen"
//     (dry run, default)
//   npx tsx tools/set-sender-email.ts --email=charles@nexgen.com --senderEmail=charles@nexgenmerchant.io --senderName="Charles @ Nexgen" --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function main() {
  const apply = process.argv.includes("--apply");
  const loginEmail = getArg("email").trim().toLowerCase();
  const senderEmail = getArg("senderEmail").trim();
  const senderName = getArg("senderName").trim();

  if (!loginEmail) {
    console.error(
      'Usage: --email=login@nexgen.com --senderEmail=sender@domain.com [--senderName="Display Name"] [--apply]'
    );
    process.exit(1);
  }
  if (!senderEmail || !isValidEmail(senderEmail)) {
    console.error("Missing/invalid --senderEmail.");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  const userSnap = await adminDb
    .collection("users")
    .where("email", "==", loginEmail)
    .limit(1)
    .get();

  if (userSnap.empty) {
    console.error(`No user found with login email ${loginEmail}.`);
    process.exit(1);
  }

  const userDoc = userSnap.docs[0];
  const uid = userDoc.id;
  const existing = userDoc.data() || {};

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Account: ${loginEmail} (uid: ${uid})`);
  console.log(
    `Current senderEmail: ${existing.senderEmail || "(none)"}  ->  New: ${senderEmail}`
  );
  console.log(
    `Current senderName:  ${existing.senderName || "(none)"}  ->  New: ${senderName || "(none)"}`
  );

  if (apply) {
    await adminDb.collection("users").doc(uid).set(
      {
        senderEmail,
        senderName,
        senderEmailUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log("\nApplied - senderEmail/senderName updated.");
  } else {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to actually apply.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
