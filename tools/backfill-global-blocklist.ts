// Seeds globalBlacklist from every existing blacklisted_numbers doc that is
// currently status="blocked", so numbers that already opted out (via STOP
// to some user's number, before the global list existed) are immediately
// honored platform-wide, not just for the one account they replied to.
//
// Safe to re-run: uses set({ merge: true }), and only ever sets status to
// "blocked" — never overwrites an existing "blocked" entry back to
// "active". If a number opted back in (START) after this runs, that
// reactivation still goes through the normal inbound webhook path.
//
// Usage:
//   npx tsx tools/backfill-global-blocklist.ts            (dry run, default)
//   npx tsx tools/backfill-global-blocklist.ts --apply      (writes for real)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  const snap = await adminDb
    .collection("blacklisted_numbers")
    .where("status", "==", "blocked")
    .get();

  console.log(`Found ${snap.size} blocked entries in blacklisted_numbers. Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  const seen = new Set<string>();
  let written = 0;
  let alreadyBlocked = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const phone = toE164(String(data.phone || ""));

    if (!phone || seen.has(phone)) {
      skipped++;
      continue;
    }
    seen.add(phone);

    const globalRef = adminDb.collection("globalBlacklist").doc(phone);
    const existing = await globalRef.get();

    if (existing.exists && String(existing.data()?.status || "").toLowerCase() === "blocked") {
      alreadyBlocked++;
      continue;
    }

    console.log(`${apply ? "Blocking" : "Would block"} ${phone} globally (from ownerUid=${data.ownerUid}, reason=${data.reason || data.keyword})`);

    if (apply) {
      await globalRef.set(
        {
          phone,
          status: "blocked",
          lastKeyword: data.keyword || "STOP",
          lastTriggeredByUid: data.ownerUid || "",
          lastTriggeredByTwilioNumber: data.twilioNumber || data.assignedTwilioNumber || "",
          lastMessageSid: data.lastMessageSid || "",
          backfilledFrom: "blacklisted_numbers",
          blockedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    written++;
  }

  console.log("\nSummary:");
  console.log(`  ${written} ${apply ? "blocked" : "would be blocked"}`);
  console.log(`  ${alreadyBlocked} already blocked globally`);
  console.log(`  ${skipped} skipped (duplicate/invalid phone)`);

  if (!apply && written > 0) {
    console.log("\nThis was a dry run. Re-run with --apply to actually write these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
