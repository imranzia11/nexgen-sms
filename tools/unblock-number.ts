// Lifts the platform-wide opt-out block on one phone number
// (globalBlacklist/{e164}), e.g. a number you own that texted STOP while
// testing. Sets status back to "active", the same state a START text would
// produce. Also lists any per-account blacklisted_numbers entries for the
// number so you can see them - those are NOT changed here.
//
// Only use this for a number whose owner has actually asked to be contacted
// again (or is your own test number).
//
// Usage:
//   npx tsx tools/unblock-number.ts --phone=+15163201660            (dry run)
//   npx tsx tools/unblock-number.ts --phone=+15163201660 --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const raw = getArg("phone").trim();
  if (!raw) {
    console.error("Usage: --phone=+15551234567 [--apply]");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { toE164 } = await import("../lib/phone");
  const { FieldValue } = await import("firebase-admin/firestore");

  const phone = toE164(raw);
  if (!/^\+\d{8,15}$/.test(phone)) {
    console.error(`"${raw}" is not a valid phone number.`);
    process.exit(1);
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Number: ${phone}`);

  const ref = adminDb.collection("globalBlacklist").doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log("globalBlacklist: no entry (not blocked platform-wide).");
  } else {
    const d = snap.data() || {};
    console.log(
      `globalBlacklist: status=${d.status} keyword=${d.lastKeyword} triggeredBy=${d.lastTriggeredByUid}`
    );
  }

  const perOwner = await adminDb
    .collection("blacklisted_numbers")
    .where("phone", "==", phone)
    .get();
  console.log(`Per-account blacklisted_numbers entries: ${perOwner.size}`);
  perOwner.docs.forEach((doc) => {
    const d = doc.data() || {};
    console.log(`  - ownerUid=${d.ownerUid} keyword=${d.keyword}`);
  });

  if (apply && snap.exists) {
    await ref.set(
      {
        status: "active",
        unblockedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log("\nApplied: platform-wide block lifted.");
  } else if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to lift the block.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
