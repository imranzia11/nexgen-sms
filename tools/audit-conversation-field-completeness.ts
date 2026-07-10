// READ-ONLY audit. Writes nothing.
//
// Why this exists: we're about to change /replies to query Firestore with
// equality filters on hasReply, lastDirection, lastOutboundStatus, and
// lastMessageAt (instead of downloading every conversation and filtering in
// the browser). Firestore excludes any document where the filtered field is
// completely missing - not false, not empty string, just absent. That's the
// exact bug that made "Customer Replied" show 156 instead of 1 a while back
// (same mechanism, different field: blocked). Before flipping these new
// queries on, we need real numbers on whether hasReply/lastDirection/
// lastOutboundStatus/lastMessageAt are reliably present on every doc, or if
// there's a population of legacy conversations that would silently vanish
// from every tab the moment we switch from "download everything and check
// in JS" to "ask Firestore to filter for us".
//
// Usage:
//   npx tsx tools/audit-conversation-field-completeness.ts
//   npx tsx tools/audit-conversation-field-completeness.ts <ownerUid>   (scope to one account)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const PAGE_SIZE = 500;

async function main() {
  const ownerUidFilter = process.argv[2];
  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(
    ownerUidFilter
      ? `Scoped to ownerUid=${ownerUidFilter}\n`
      : "Scanning ALL conversations (all owners)\n"
  );

  let scanned = 0;
  let missingHasReply = 0;
  let missingLastDirection = 0;
  let missingLastOutboundStatus = 0;
  let missingLastMessageAt = 0;
  let missingBlocked = 0;
  let missingPinned = 0; // expected to be common/normal - pinned is opt-in
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  const examples: Record<string, string[]> = {
    hasReply: [],
    lastDirection: [],
    lastOutboundStatus: [],
    lastMessageAt: [],
    blocked: [],
  };

  function noteExample(field: string, id: string) {
    if (examples[field].length < 10) examples[field].push(id);
  }

  for (;;) {
    let q = adminDb
      .collection("conversations")
      .orderBy("__name__")
      .limit(PAGE_SIZE) as FirebaseFirestore.Query;

    if (ownerUidFilter) {
      q = adminDb
        .collection("conversations")
        .where("ownerUid", "==", ownerUidFilter)
        .orderBy("__name__")
        .limit(PAGE_SIZE);
    }

    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() || {};

      if (data.hasReply !== true && data.hasReply !== false) {
        missingHasReply++;
        noteExample("hasReply", doc.id);
      }
      if (typeof data.lastDirection !== "string" || !data.lastDirection.trim()) {
        missingLastDirection++;
        noteExample("lastDirection", doc.id);
      }
      if (
        typeof data.lastOutboundStatus !== "string" ||
        !data.lastOutboundStatus.trim()
      ) {
        missingLastOutboundStatus++;
        noteExample("lastOutboundStatus", doc.id);
      }
      if (!data.lastMessageAt) {
        missingLastMessageAt++;
        noteExample("lastMessageAt", doc.id);
      }
      if (data.blocked !== true && data.blocked !== false) {
        missingBlocked++;
        noteExample("blocked", doc.id);
      }
      if (data.pinned !== true) {
        missingPinned++;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }

  console.log("Summary:");
  console.log(`  ${scanned} conversations scanned`);
  console.log(
    `  ${missingHasReply} missing 'hasReply' (would vanish from Replied AND Never-Replied tabs)`
  );
  console.log(
    `  ${missingLastDirection} missing 'lastDirection' (would vanish from Replied/Waiting tabs)`
  );
  console.log(
    `  ${missingLastOutboundStatus} missing 'lastOutboundStatus' (fine - only affects Failed tab, and that's expected for anything never failed)`
  );
  console.log(
    `  ${missingLastMessageAt} missing 'lastMessageAt' (would vanish entirely - no way to sort/limit it into any page)`
  );
  console.log(`  ${missingBlocked} missing 'blocked' (should be 0 - was backfilled earlier)`);
  console.log(
    `  ${missingPinned} not pinned (expected/normal - most conversations are never pinned)`
  );

  console.log("\nExample doc IDs for each gap (up to 10 each):");
  for (const [field, ids] of Object.entries(examples)) {
    if (ids.length > 0) {
      console.log(`  ${field}: ${ids.join(", ")}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
  });
