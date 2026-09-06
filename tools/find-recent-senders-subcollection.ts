// Read-only investigation script, follow-up to find-recent-senders.ts.
//
// That script proved the root `messages` collection is stale (no writes
// since 2026-08-26), so it cannot explain a balance drop happening in the
// days since. Every send path also writes a per-conversation copy to
// conversations/{convoId}/messages/{sid} (see app/api/send-sms/route.ts
// ~line 325 and app/api/send-reply/route.ts) with the SAME field shape
// (ownerUid, createdAt, status, to, direction) - so this script runs the
// identical grouping logic against a Firestore collection group query over
// every conversation's messages subcollection instead. Nothing is written.
//
// Usage:
//   npx tsx tools/find-recent-senders-subcollection.ts --hours=72

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  const hours = Number(getArg("hours", "72")) || 72;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  console.log(
    `Looking at conversations/*/messages sent in the last ${hours} hour(s) (since ${cutoff.toISOString()})...\n`
  );

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { Timestamp } = await import("firebase-admin/firestore");

  const snap = await adminDb
    .collectionGroup("messages")
    .where("createdAt", ">=", Timestamp.fromDate(cutoff))
    .orderBy("createdAt", "asc")
    .get();

  if (snap.empty) {
    console.log("No messages found in that window via the conversations/*/messages collection group either.");
    console.log("Showing the 20 most recent docs across all conversation threads (no time filter):\n");

    const recentSnap = await adminDb
      .collectionGroup("messages")
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    if (recentSnap.empty) {
      console.log("The conversations/*/messages collection group has ZERO documents with createdAt at all.");
      return;
    }

    recentSnap.docs.forEach((d) => {
      const data = d.data() as Record<string, any>;
      const createdAt =
        typeof data.createdAt?.toDate === "function" ? data.createdAt.toDate().toISOString() : "(no createdAt)";
      console.log(
        `${createdAt}  ownerUid=${data.ownerUid || "?"}  status=${data.status || "?"}  to=${data.to || "?"}  direction=${data.direction || "?"}`
      );
    });
    return;
  }

  type Bucket = {
    count: number;
    delivered: number;
    failed: number;
    other: number;
    inbound: number;
    outbound: number;
    firstAt?: Date;
    lastAt?: Date;
  };

  const byOwner = new Map<string, Bucket>();

  snap.docs.forEach((d) => {
    const data = d.data() as Record<string, any>;
    const ownerUid = String(data.ownerUid || "(missing ownerUid)");
    const status = String(data.status || "").toLowerCase();
    const direction = String(data.direction || "").toLowerCase();
    const createdAt: Date | undefined =
      typeof data.createdAt?.toDate === "function" ? data.createdAt.toDate() : undefined;

    const bucket = byOwner.get(ownerUid) || {
      count: 0,
      delivered: 0,
      failed: 0,
      other: 0,
      inbound: 0,
      outbound: 0,
    };

    bucket.count++;
    if (status === "delivered" || status === "sent") bucket.delivered++;
    else if (status === "failed" || status === "undelivered" || status === "error") bucket.failed++;
    else bucket.other++;

    if (direction === "inbound") bucket.inbound++;
    else if (direction === "outbound") bucket.outbound++;

    if (createdAt) {
      if (!bucket.firstAt || createdAt < bucket.firstAt) bucket.firstAt = createdAt;
      if (!bucket.lastAt || createdAt > bucket.lastAt) bucket.lastAt = createdAt;
    }

    byOwner.set(ownerUid, bucket);
  });

  const uids = [...byOwner.keys()].filter((u) => u !== "(missing ownerUid)");
  const nameByUid = new Map<string, string>();

  for (const uid of uids) {
    try {
      const userSnap = await adminDb.collection("users").doc(uid).get();
      const data = userSnap.data();
      nameByUid.set(uid, data?.name || data?.email || "(unknown)");
    } catch {
      nameByUid.set(uid, "(lookup failed)");
    }
  }

  const rows = [...byOwner.entries()].sort((a, b) => b[1].outbound - a[1].outbound);

  console.log(`Total messages in window (both directions): ${snap.size}\n`);
  console.log(
    "Owner".padEnd(28),
    "Name".padEnd(24),
    "Out".padEnd(6),
    "In".padEnd(6),
    "Delivered".padEnd(11),
    "Failed".padEnd(8),
    "First".padEnd(22),
    "Last"
  );
  console.log("-".repeat(130));

  for (const [uid, bucket] of rows) {
    const name = uid === "(missing ownerUid)" ? "-" : nameByUid.get(uid) || "-";
    console.log(
      uid.padEnd(28),
      name.padEnd(24),
      String(bucket.outbound).padEnd(6),
      String(bucket.inbound).padEnd(6),
      String(bucket.delivered).padEnd(11),
      String(bucket.failed).padEnd(8),
      (bucket.firstAt?.toLocaleString() || "-").padEnd(22),
      bucket.lastAt?.toLocaleString() || "-"
    );
  }

  console.log(
    "\nNote: outbound count is send attempts, not dollars - MMS/media and long segments cost more per message than plain SMS."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    console.error(
      "\nIf this fails with a 'query requires an index' error, Firestore collection-group queries with a where+orderBy on a new field need a composite index - the error message includes a direct link to create it in the console."
    );
    process.exit(1);
  });
