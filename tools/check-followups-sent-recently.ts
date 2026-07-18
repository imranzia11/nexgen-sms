// READ-ONLY. System-wide check (all accounts, not just one user): has ANY
// follow-up actually been sent recently, and how many are stuck overdue-
// pending right now? This is the direct test of "no scheduler is calling
// /api/cron/send-followups" - if that's true, there should be zero "sent"
// docs with a recent sentAt, and a growing pile of overdue "pending" docs.
//
// Usage:
//   npx tsx tools/check-followups-sent-recently.ts

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

  const snap = await adminDb.collection("followUps").get();

  if (snap.empty) {
    console.log("No followUps docs exist in the entire database.");
    return;
  }

  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as any));

  const now = Date.now();
  const byStatus: Record<string, number> = {};
  let mostRecentSentAt: Date | null = null;
  let mostRecentSentDoc: any = null;
  const overduePending: any[] = [];

  for (const doc of docs) {
    const status = String(doc.status || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;

    if (status === "sent") {
      const sentAt = toDate(doc.sentAt) || toDate(doc.dueAt);
      if (sentAt && (!mostRecentSentAt || sentAt.getTime() > mostRecentSentAt.getTime())) {
        mostRecentSentAt = sentAt;
        mostRecentSentDoc = doc;
      }
    }

    if (status === "pending") {
      const dueAt = toDate(doc.dueAt);
      if (dueAt && dueAt.getTime() < now) {
        overduePending.push(doc);
      }
    }
  }

  console.log(`Total followUps docs (all accounts): ${docs.length}\n`);
  console.log("=== Status breakdown ===");
  Object.entries(byStatus).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });

  console.log("");
  if (mostRecentSentDoc) {
    console.log(`Most recent "sent" follow-up: ${mostRecentSentDoc.id}`);
    console.log(`  ownerUid: ${mostRecentSentDoc.ownerUid}`);
    console.log(`  phone:    ${mostRecentSentDoc.phone}`);
    console.log(`  sentAt:   ${fmt(mostRecentSentDoc.sentAt)}`);
  } else {
    console.log("No follow-up doc anywhere has ever reached status \"sent\".");
  }

  console.log("");
  console.log(`Overdue-and-still-pending follow-ups (across ALL accounts): ${overduePending.length}`);
  overduePending
    .sort((a, b) => (toDate(a.dueAt)?.getTime() || 0) - (toDate(b.dueAt)?.getTime() || 0))
    .slice(0, 20)
    .forEach((doc) => {
      console.log(
        `  - ${doc.id} | ownerUid=${doc.ownerUid} | phone=${doc.phone} | dueAt=${fmt(doc.dueAt)}`
      );
    });

  console.log("");
  if (!mostRecentSentDoc && overduePending.length > 0) {
    console.log(
      "CONFIRMED: zero follow-ups have ever been sent, and there is a growing backlog of " +
        "overdue-pending ones. This proves /api/cron/send-followups has never been called by " +
        "anything, for any account - not a per-user issue. The Cloud Scheduler job needs to be " +
        "set up for this to start working at all, for every client."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
