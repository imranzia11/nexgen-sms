// READ-ONLY. Investigates why a specific user's scheduled follow-ups did
// or didn't send - lists every followUps doc for that ownerUid, flags any
// that are still "pending" despite their dueAt already being in the past
// (which is exactly what happens with zero cron/scheduler ever calling
// /api/cron/send-followups - see chat), and sanity-checks the user's own
// account fields that sendSmsForUser depends on (twilioNumber, isActive).
//
// Usage:
//   npx tsx tools/diagnose-followups-for-user.ts <ownerUid>
// Example:
//   npx tsx tools/diagnose-followups-for-user.ts 8JHmWXe9GldYdtjgvX4KBcWh1423

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
  const ownerUid = process.argv[2];

  if (!ownerUid) {
    console.error("Usage: npx tsx tools/diagnose-followups-for-user.ts <ownerUid>");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");

  const userSnap = await adminDb.collection("users").doc(ownerUid).get();
  if (!userSnap.exists) {
    console.log(`No user doc found for uid ${ownerUid}.`);
  } else {
    const u = userSnap.data() || {};
    console.log("=== User account ===");
    console.log(`  email:        ${u.email || "(none)"}`);
    console.log(`  name:         ${u.name || "(none)"}`);
    console.log(`  isActive:     ${u.isActive}`);
    console.log(`  twilioNumber: ${u.twilioNumber || u.assignedTwilioNumber || "(none)"}`);
    console.log(`  messagingServiceSid: ${u.messagingServiceSid || "(none)"}`);
    console.log("");
  }

  // Also check campaigns - this tells us whether the follow-up checkbox was
  // actually ON when a campaign was sent, independent of whether the
  // schedule-follow-up API call itself succeeded.
  const campaignsSnap = await adminDb
    .collection("campaigns")
    .where("ownerUid", "==", ownerUid)
    .get();

  if (!campaignsSnap.empty) {
    const campaigns = campaignsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .sort((a, b) => {
        const at = toDate(a.createdAt)?.getTime() || 0;
        const bt = toDate(b.createdAt)?.getTime() || 0;
        return bt - at;
      })
      .slice(0, 10);

    console.log("=== Recent campaigns (most recent 10) ===");
    for (const c of campaigns) {
      console.log(`--- ${c.id} ---`);
      console.log(`  name:             ${c.name || "(none)"}`);
      console.log(`  createdAt:        ${fmt(c.createdAt)}`);
      console.log(`  totalRecipients:  ${c.totalRecipients}`);
      console.log(`  successCount:     ${c.successCount}`);
      console.log(`  followUpEnabled:  ${c.followUpEnabled === true ? "YES" : "no"}`);
      console.log(`  followUpHours:    ${c.followUpHours ?? "(none)"}`);
      console.log("");
    }
  } else {
    console.log("No campaigns docs found for this ownerUid at all.\n");
  }

  const snap = await adminDb
    .collection("followUps")
    .where("ownerUid", "==", ownerUid)
    .get();

  if (snap.empty) {
    console.log(
      "No followUps docs found for this ownerUid at all.\n\n" +
        "If any campaign above shows followUpEnabled: YES but there is still no " +
        "matching followUps doc, that means the schedule-follow-up API call " +
        "failed or was never reached after the SMS send - NOT a missing-cron " +
        "issue, since a cron can't send something that was never created. " +
        "If every campaign shows followUpEnabled: no, then the follow-up " +
        "checkbox was simply never turned on for these sends, and the client's " +
        "\"never sent\" report is about a follow-up that was never scheduled " +
        "in the first place."
    );
    return;
  }

  const now = Date.now();
  const docs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as any))
    .sort((a, b) => {
      const at = toDate(a.dueAt)?.getTime() || 0;
      const bt = toDate(b.dueAt)?.getTime() || 0;
      return bt - at;
    });

  console.log(`Found ${docs.length} followUps doc(s) for this user.\n`);

  const byStatus: Record<string, number> = {};
  const stuckPending: any[] = [];

  for (const doc of docs) {
    const status = String(doc.status || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;

    const dueAtDate = toDate(doc.dueAt);
    const isOverdue = dueAtDate ? dueAtDate.getTime() < now : false;

    if (status === "pending" && isOverdue) {
      stuckPending.push(doc);
    }

    console.log(`--- ${doc.id} ---`);
    console.log(`  phone:      ${doc.phone}`);
    console.log(`  status:     ${status}${status === "pending" && isOverdue ? "  <-- OVERDUE, still pending" : ""}`);
    console.log(`  dueAt:      ${fmt(doc.dueAt)}`);
    console.log(`  createdAt:  ${fmt(doc.createdAt)}`);
    console.log(`  sentAt:     ${doc.sentAt ? fmt(doc.sentAt) : "(none)"}`);
    console.log(`  campaign:   ${doc.campaignName || "(none)"}`);
    console.log(`  message:    ${String(doc.followUpMessage || "").slice(0, 80)}`);
    if (doc.error) console.log(`  error:      ${doc.error}`);
    if (doc.skippedReason) console.log(`  skippedReason: ${doc.skippedReason}`);
    console.log("");
  }

  console.log("=== Summary ===");
  Object.entries(byStatus).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });

  console.log("");
  if (stuckPending.length > 0) {
    console.log(
      `${stuckPending.length} follow-up(s) are PAST their dueAt but still "pending" - ` +
        `this confirms nothing has ever called /api/cron/send-followups for this account. ` +
        `Once the Cloud Scheduler job is set up, the very next run (within 15 min) will pick ` +
        `these up immediately, since the cron's own query is "status == pending AND dueAt <= now" ` +
        `with no upper bound on how overdue - it doesn't matter that they're a day late.`
    );
  } else {
    console.log(
      "No overdue-pending follow-ups found right now - either they already got sent/skipped, " +
        "or none are past due yet. If the client says a specific message never arrived, check " +
        "the individual doc(s) above for status/error/skippedReason."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
