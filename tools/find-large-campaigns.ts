// READ-ONLY. The `campaigns` collection turned out to have zero record of
// any bulk send with follow-up enabled - every followUpEnabled campaign
// found was a single-recipient "Direct Send" (see
// find-broken-followup-campaigns.ts output). That means either the
// campaign doc was never written at all (e.g. the whole handleSendSms
// flow threw before reaching that addDoc call, which happens AFTER the
// actual sends), or it was written with followUpEnabled: false despite
// the checkbox being on.
//
// This scans the `messages` collection directly instead - the one place
// every successful send always logs itself (see app/api/send-sms/route.ts)
// regardless of whether the campaign summary doc came out right - grouped
// by (ownerUid, campaignName), to find the actual large send.
//
// Usage:
//   npx tsx tools/find-large-campaigns.ts [minCount] [daysBack]
// Example (default: 50 messages minimum, last 30 days):
//   npx tsx tools/find-large-campaigns.ts 50 30

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

async function main() {
  const minCount = Number(process.argv[2] || 50);
  const daysBack = Number(process.argv[3] || 30);

  const { adminDb } = await import("../lib/firebaseAdmin");

  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  console.log(`Scanning outbound messages from the last ${daysBack} day(s)...\n`);

  const snap = await adminDb
    .collection("messages")
    .where("direction", "==", "outbound")
    .get();

  console.log(`Fetched ${snap.size} total outbound message doc(s) (all time) - filtering to the requested window in memory.\n`);

  type Group = {
    ownerUid: string;
    campaignName: string;
    count: number;
    successCount: number;
    firstAt: number;
    lastAt: number;
  };

  const groups = new Map<string, Group>();

  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const createdAtMs = toDate(data.createdAt)?.getTime() || 0;
    if (createdAtMs < cutoff.getTime()) return;

    const ownerUid = String(data.ownerUid || "");
    const campaignName = String(data.campaignName || "(none)");
    const key = `${ownerUid}::${campaignName}`;

    const existing = groups.get(key) || {
      ownerUid,
      campaignName,
      count: 0,
      successCount: 0,
      firstAt: createdAtMs,
      lastAt: createdAtMs,
    };

    existing.count++;
    const status = String(data.status || "").toLowerCase();
    if (["queued", "accepted", "scheduled", "sending", "sent", "delivered"].includes(status)) {
      existing.successCount++;
    }
    existing.firstAt = Math.min(existing.firstAt, createdAtMs);
    existing.lastAt = Math.max(existing.lastAt, createdAtMs);

    groups.set(key, existing);
  });

  const sorted = Array.from(groups.values())
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count);

  if (sorted.length === 0) {
    console.log(`No (ownerUid, campaignName) group found with >= ${minCount} messages in the last ${daysBack} days.`);
    console.log("Try a smaller minCount or larger daysBack, e.g.: npx tsx tools/find-large-campaigns.ts 10 90");
    return;
  }

  console.log(`=== Groups with >= ${minCount} messages ===\n`);
  for (const g of sorted) {
    console.log(`  ownerUid:      ${g.ownerUid}`);
    console.log(`  campaignName:  ${g.campaignName}`);
    console.log(`  message count: ${g.count}  (successful: ${g.successCount})`);
    console.log(`  first sent:    ${new Date(g.firstAt).toISOString()}`);
    console.log(`  last sent:     ${new Date(g.lastAt).toISOString()}`);
    console.log("");
  }

  console.log(
    "Next: for the group that matches your 5k blast, run\n" +
      "  npx tsx tools/diagnose-followups-for-user.ts <ownerUid>\n" +
      "to see whether a campaigns doc exists at all for that name, and whether followUpEnabled came out true or false."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
