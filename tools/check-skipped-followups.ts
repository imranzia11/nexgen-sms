// READ-ONLY. Lists every followUps doc across ALL accounts with
// status == "skipped", so we can see exactly which ones were skipped and
// why (hasReply vs blocked) before the hasReply skip was removed from
// app/api/cron/send-followups/route.ts.
//
// Usage:
//   npx tsx tools/check-skipped-followups.ts [daysBack]
// Example (default is all-time; pass a number to limit to recent days):
//   npx tsx tools/check-skipped-followups.ts 4

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

function fmt(value: any): string {
  const d = toDate(value);
  return d ? d.toISOString() : "(none)";
}

async function main() {
  const daysBack = process.argv[2] ? Number(process.argv[2]) : null;
  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb
    .collection("followUps")
    .where("status", "==", "skipped")
    .get();

  if (snap.empty) {
    console.log("No skipped followUps docs found across any account.");
    return;
  }

  let docs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as any))
    .sort((a, b) => (toDate(b.dueAt)?.getTime() || 0) - (toDate(a.dueAt)?.getTime() || 0));

  if (daysBack) {
    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    docs = docs.filter((doc) => {
      const ms = toDate(doc.dueAt)?.getTime() || toDate(doc.createdAt)?.getTime() || 0;
      return ms >= cutoff;
    });
    console.log(`Filtering to the last ${daysBack} day(s) (by dueAt/createdAt).\n`);
  }

  if (docs.length === 0) {
    console.log("No skipped followUps docs found in that window.");
    return;
  }

  console.log(`Found ${docs.length} skipped followUps doc(s):\n`);

  const byReason: Record<string, number> = {};

  for (const doc of docs) {
    const reason = String(doc.skippedReason || "unknown");
    byReason[reason] = (byReason[reason] || 0) + 1;

    console.log(`--- ${doc.id} ---`);
    console.log(`  ownerUid:      ${doc.ownerUid}`);
    console.log(`  phone:         ${doc.phone}`);
    console.log(`  skippedReason: ${reason}`);
    console.log(`  dueAt:         ${fmt(doc.dueAt)}`);
    console.log(`  createdAt:     ${fmt(doc.createdAt)}`);
    console.log(`  campaign:      ${doc.campaignName || "(none)"}`);
    console.log(`  message:       ${String(doc.followUpMessage || "").slice(0, 70)}`);
    console.log("");
  }

  console.log("=== Summary by reason ===");
  Object.entries(byReason).forEach(([reason, count]) => {
    console.log(`  ${reason}: ${count}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
