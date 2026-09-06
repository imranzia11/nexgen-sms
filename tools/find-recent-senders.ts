// Read-only investigation script: there is exactly ONE shared Twilio
// account behind every rep on this platform (see components/TwilioBalanceCard.tsx),
// so a balance drop always comes from SOME rep's send activity, not a
// separate account. This groups recent sends from the root `messages`
// collection by ownerUid so you can see who actually sent what, and when,
// without guessing. Nothing is written.
//
// Usage:
//   npx tsx tools/find-recent-senders.ts --hours=6
//   npx tsx tools/find-recent-senders.ts --hours=24

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  const hours = Number(getArg("hours", "6")) || 6;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  console.log(`Looking at messages sent in the last ${hours} hour(s) (since ${cutoff.toISOString()})...\n`);

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { Timestamp } = await import("firebase-admin/firestore");

  const snap = await adminDb
    .collection("messages")
    .where("createdAt", ">=", Timestamp.fromDate(cutoff))
    .orderBy("createdAt", "asc")
    .get();

  if (snap.empty) {
    console.log("No messages found in that window.");
    return;
  }

  type Bucket = {
    count: number;
    delivered: number;
    failed: number;
    other: number;
    firstAt?: Date;
    lastAt?: Date;
  };

  const byOwner = new Map<string, Bucket>();

  snap.docs.forEach((d) => {
    const data = d.data() as Record<string, any>;
    const ownerUid = String(data.ownerUid || "(missing ownerUid)");
    const status = String(data.status || "").toLowerCase();
    const createdAt: Date | undefined =
      typeof data.createdAt?.toDate === "function" ? data.createdAt.toDate() : undefined;

    const bucket = byOwner.get(ownerUid) || {
      count: 0,
      delivered: 0,
      failed: 0,
      other: 0,
    };

    bucket.count++;
    if (status === "delivered" || status === "sent") bucket.delivered++;
    else if (status === "failed" || status === "undelivered" || status === "error") bucket.failed++;
    else bucket.other++;

    if (createdAt) {
      if (!bucket.firstAt || createdAt < bucket.firstAt) bucket.firstAt = createdAt;
      if (!bucket.lastAt || createdAt > bucket.lastAt) bucket.lastAt = createdAt;
    }

    byOwner.set(ownerUid, bucket);
  });

  // Look up names for readability.
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

  const rows = [...byOwner.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`Total messages in window: ${snap.size}\n`);
  console.log("Owner".padEnd(28), "Name".padEnd(24), "Sent", "Delivered", "Failed", "First", "Last");
  console.log("-".repeat(120));

  for (const [uid, bucket] of rows) {
    const name = uid === "(missing ownerUid)" ? "-" : nameByUid.get(uid) || "-";
    console.log(
      uid.padEnd(28),
      name.padEnd(24),
      String(bucket.count).padEnd(6),
      String(bucket.delivered).padEnd(11),
      String(bucket.failed).padEnd(8),
      (bucket.firstAt?.toLocaleString() || "-").padEnd(22),
      bucket.lastAt?.toLocaleString() || "-"
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
