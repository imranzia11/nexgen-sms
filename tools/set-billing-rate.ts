// Turns on the Billing tab for one account and sets its flat per-SMS rate
// (charged on every SMS sent AND every SMS received). Accounts without
// billingRatePerSms never see the tab - see app/api/billing/route.ts.
//
// Usage:
//   npx tsx tools/set-billing-rate.ts --email=user@example.com --rate=0.30
//     (dry run, default)
//   npx tsx tools/set-billing-rate.ts --email=user@example.com --rate=0.30 --apply
//   npx tsx tools/set-billing-rate.ts --email=user@example.com --rate=0 --apply
//     (rate 0 turns the tab back off)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const loginEmail = getArg("email").trim().toLowerCase();
  const rate = Number(getArg("rate"));

  if (!loginEmail || !Number.isFinite(rate) || rate < 0) {
    console.error("Usage: --email=login@example.com --rate=0.30 [--apply]");
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
  const existing = userDoc.data() || {};

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Account: ${loginEmail} (uid: ${userDoc.id})`);
  console.log(`Current rate: ${existing.billingRatePerSms ?? "(none)"}  ->  New: ${rate}`);

  if (apply) {
    await adminDb.collection("users").doc(userDoc.id).set(
      { billingRatePerSms: rate, billingRateUpdatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log("\nApplied.");
  } else {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to apply.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
