// Turns browser click-to-call on (or off) for one account by setting
// users/{uid}.voiceEnabled. Accounts without it never see the call icon and
// can't get a voice token - see app/api/voice/token/route.ts.
//
// Usage:
//   npx tsx tools/set-voice-enabled.ts --email=user@example.com --enabled=true
//     (dry run, default)
//   npx tsx tools/set-voice-enabled.ts --email=user@example.com --enabled=true --apply
//   npx tsx tools/set-voice-enabled.ts --email=user@example.com --enabled=false --apply

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
  const enabledArg = getArg("enabled").trim().toLowerCase();

  if (!loginEmail || (enabledArg !== "true" && enabledArg !== "false")) {
    console.error("Usage: --email=login@example.com --enabled=true|false [--apply]");
    process.exit(1);
  }
  const enabled = enabledArg === "true";

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
  console.log(`Twilio number: ${existing.twilioNumber || "(none)"}`);
  console.log(`voiceEnabled: ${existing.voiceEnabled ?? "(none)"}  ->  ${enabled}`);

  if (apply) {
    await adminDb.collection("users").doc(userDoc.id).set(
      { voiceEnabled: enabled, voiceUpdatedAt: FieldValue.serverTimestamp() },
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
