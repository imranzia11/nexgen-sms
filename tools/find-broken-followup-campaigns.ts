// READ-ONLY. System-wide scan across ALL accounts for campaigns that had
// follow-up enabled but ended up with few or zero matching followUps docs -
// this is exactly the shape of the bug fixed in app/dashboard/page.tsx
// (scheduleFollowUp was called once at the very end of a large chunked
// send using a token captured before the send started; a big enough send
// let that token expire, failing the ENTIRE follow-up schedule for every
// recipient at once, even though every message itself sent fine).
//
// Usage:
//   npx tsx tools/find-broken-followup-campaigns.ts

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
  const { adminDb } = await import("../lib/firebaseAdmin");

  const campaignsSnap = await adminDb
    .collection("campaigns")
    .where("followUpEnabled", "==", true)
    .get();

  if (campaignsSnap.empty) {
    console.log("No campaigns found anywhere with followUpEnabled == true.");
    return;
  }

  const campaigns = campaignsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() } as any))
    .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));

  console.log(`Checking ${campaigns.length} campaign(s) with followUpEnabled == true...\n`);

  const flagged: any[] = [];

  for (const c of campaigns) {
    const followUpsSnap = await adminDb
      .collection("followUps")
      .where("ownerUid", "==", c.ownerUid)
      .where("campaignName", "==", c.name)
      .get();

    const expected = Number(c.successCount || c.totalRecipients || 0);
    const found = followUpsSnap.size;

    // Flag anything where the gap is real - a handful of legitimately
    // blocked/invalid numbers is normal and expected, so only flag when
    // the shortfall is large relative to how many messages actually sent.
    const shortfall = expected - found;
    const isSuspicious = expected >= 10 && shortfall > Math.max(5, expected * 0.2);

    console.log(`--- ${c.id} ---`);
    console.log(`  ownerUid:        ${c.ownerUid}`);
    console.log(`  name:            ${c.name}`);
    console.log(`  createdAt:       ${fmt(c.createdAt)}`);
    console.log(`  totalRecipients: ${c.totalRecipients}`);
    console.log(`  successCount:    ${c.successCount}`);
    console.log(`  followUpHours:   ${c.followUpHours ?? "(none)"}`);
    console.log(`  followUps found: ${found}`);
    console.log(`  ${isSuspicious ? "*** LIKELY HIT THE BUG - most/all follow-ups missing ***" : "looks fine"}`);
    console.log("");

    if (isSuspicious) {
      flagged.push({ ...c, followUpsFound: found });
    }
  }

  if (flagged.length === 0) {
    console.log("No campaigns look affected - every followUpEnabled campaign has a reasonable number of matching followUps docs.");
    return;
  }

  console.log("=== Campaigns that likely need recovery ===");
  for (const c of flagged) {
    console.log(`  ownerUid: ${c.ownerUid}   name: "${c.name}"   (${c.followUpsFound} found / ${c.successCount || c.totalRecipients} expected)`);
  }
  console.log(
    "\nFor each one above, run:\n" +
      "  npx tsx tools/recover-missing-followups.ts <ownerUid> \"<name>\"\n" +
      "(quote the campaign name exactly as printed if it has spaces)"
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
