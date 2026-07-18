// READ-ONLY. Writes nothing, deletes nothing.
//
// app/replies/page.tsx has a scoped, tab-limited conversations query
// (buildScopedConversationsQuery) that's currently disabled via
// SCOPED_LIST_ENABLED = false, because it orders by `lastMessageAt` and
// Firestore silently excludes any conversation document missing that field
// from the results entirely (not an error - just absent). That already
// caused a real incident once (a genuine "Customer Replied" conversation
// vanished from its tab). Until now nobody had checked how common the gap
// actually is.
//
// This is also why the /replies list currently loads ALL conversations for
// the account on every page load instead of a small recent batch - the
// fallback (unscoped) query has no limit at all.
//
// This script counts, per account: total conversations, and how many are
// missing `lastMessageAt` (undefined, null, or not a Firestore Timestamp).
// Read-only - just tells us the size of the gap so we can decide whether a
// backfill is needed before flipping SCOPED_LIST_ENABLED back to true.
//
// Usage:
//   npx tsx tools/audit-lastmessageat-completeness.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function auditOwner(adminDb: any, ownerUid: string, label: string) {
  const snap = await adminDb.collection("conversations").where("ownerUid", "==", ownerUid).get();

  let missing = 0;
  let present = 0;
  const exampleMissing: string[] = [];

  for (const d of snap.docs) {
    const data = d.data();
    const v = data.lastMessageAt;
    const ok = typeof v?.toDate === "function";
    if (ok) {
      present++;
    } else {
      missing++;
      if (exampleMissing.length < 8) {
        exampleMissing.push(
          `${d.id} (lastMessageAt=${JSON.stringify(v)}, updatedAt=${data.updatedAt ? "present" : "missing"}, lastMessage=${JSON.stringify(String(data.lastMessage || "").slice(0, 30))})`
        );
      }
    }
  }

  console.log(`=== ${label} (${ownerUid}) ===`);
  console.log(`  ${snap.docs.length} total conversations, ${present} with valid lastMessageAt, ${missing} missing/invalid`);
  if (exampleMissing.length) {
    console.log(`  examples missing:\n    ${exampleMissing.join("\n    ")}`);
  }
  console.log("");
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");
  const usersSnap = await adminDb.collection("users").get();

  for (const userDoc of usersSnap.docs) {
    const label = userDoc.data()?.name || userDoc.data()?.email || userDoc.id;
    await auditOwner(adminDb, userDoc.id, label);
  }

  console.log("Done. Nothing was written or deleted.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
