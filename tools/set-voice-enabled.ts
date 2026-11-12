// Turns browser click-to-call on (or off) for one account, or for every
// active account, by setting users/{uid}.voiceEnabled. Accounts without it
// never see the call icon and can't get a voice token - see
// app/api/voice/token/route.ts.
//
// Usage:
//   npx tsx tools/set-voice-enabled.ts --email=user@example.com --enabled=true
//     (dry run, default)
//   npx tsx tools/set-voice-enabled.ts --email=user@example.com --enabled=true --apply
//   npx tsx tools/set-voice-enabled.ts --email=user@example.com --enabled=false --apply
//
//   npx tsx tools/set-voice-enabled.ts --all --enabled=true            (dry run)
//   npx tsx tools/set-voice-enabled.ts --all --enabled=true --apply
//     --all covers every ACTIVE, non-superadmin account that has a Twilio
//     number. Inactive accounts and superadmins are skipped.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const all = process.argv.includes("--all");
  const loginEmail = getArg("email").trim().toLowerCase();
  const enabledArg = getArg("enabled").trim().toLowerCase();

  if ((!all && !loginEmail) || (enabledArg !== "true" && enabledArg !== "false")) {
    console.error("Usage: (--email=login@example.com | --all) --enabled=true|false [--apply]");
    process.exit(1);
  }
  const enabled = enabledArg === "true";

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);

  if (all) {
    const snap = await adminDb.collection("users").get();
    let changed = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const role = String(d.role || "").toLowerCase();
      const number = String(d.twilioNumber || d.assignedTwilioNumber || "").trim();

      if (d.isActive !== true || role === "superadmin" || !number) {
        skipped += 1;
        continue;
      }

      console.log(
        `${d.email || doc.id}  (${number})  voiceEnabled: ${d.voiceEnabled ?? "(none)"} -> ${enabled}`
      );
      changed += 1;

      if (apply) {
        await adminDb.collection("users").doc(doc.id).set(
          { voiceEnabled: enabled, voiceUpdatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
    }

    console.log(`\n${changed} account(s) ${apply ? "updated" : "would be updated"}, ${skipped} skipped.`);
    if (!apply) console.log("DRY RUN - nothing written. Re-run with --apply to apply.");
    return;
  }

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
