// READ-ONLY. Writes nothing, deletes nothing.
//
// buildScopedConversationsQuery (app/replies/page.tsx) filters/orders on
// several fields across its different tabs:
//   - ALL tabs: where("blocked", "==", false)   <- highest risk, gates every tab
//   - pinned tab: where("pinned", "==", true)   <- doesn't affect other tabs
//   - replied/awaiting: where("hasReply", "==", true/false) + lastDirection
//   - never_replied: where("hasReply", "==", false)
//   - failed: where("lastOutboundStatus", "in", [...])
//   - ALL tabs: orderBy("lastMessageAt", "desc")  <- already confirmed 100%
//
// Firestore silently excludes any document missing a field used in a
// where/orderBy clause from query results - it's not an error, the doc
// just never comes back. Since `blocked` is filtered on EVERY tab, if any
// conversation lacks that field entirely, it would vanish from the whole
// /replies list the moment the scoped query goes live, even though it
// still exists and would show under the old unscoped query.
//
// This checks field presence/type for blocked, hasReply, lastDirection,
// and lastOutboundStatus across every conversation for all 5 accounts.
//
// Usage:
//   npx tsx tools/audit-scoped-query-fields.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function auditOwner(adminDb: any, ownerUid: string, label: string) {
  const snap = await adminDb.collection("conversations").where("ownerUid", "==", ownerUid).get();

  let missingBlocked = 0;
  let missingHasReply = 0;
  let missingLastDirection = 0;
  let missingLastOutboundStatus = 0;
  const exampleMissingBlocked: string[] = [];

  for (const d of snap.docs) {
    const data = d.data();

    if (typeof data.blocked !== "boolean") {
      missingBlocked++;
      if (exampleMissingBlocked.length < 8) {
        exampleMissingBlocked.push(`${d.id} (blocked=${JSON.stringify(data.blocked)})`);
      }
    }
    if (typeof data.hasReply !== "boolean") missingHasReply++;
    if (typeof data.lastDirection !== "string" || !data.lastDirection) missingLastDirection++;
    if (typeof data.lastOutboundStatus !== "string" || !data.lastOutboundStatus) missingLastOutboundStatus++;
  }

  console.log(`=== ${label} (${ownerUid}) ===`);
  console.log(`  ${snap.docs.length} total conversations`);
  console.log(`  missing/non-boolean 'blocked' (gates ALL tabs): ${missingBlocked}`);
  console.log(`  missing/non-boolean 'hasReply': ${missingHasReply}`);
  console.log(`  missing/empty 'lastDirection': ${missingLastDirection}`);
  console.log(`  missing/empty 'lastOutboundStatus' (only affects Failed tab): ${missingLastOutboundStatus}`);
  if (exampleMissingBlocked.length) {
    console.log(`  examples missing blocked:\n    ${exampleMissingBlocked.join("\n    ")}`);
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
