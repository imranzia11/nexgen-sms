// READ-ONLY. Fast version: uses count() aggregation instead of downloading
// every document, so this returns in seconds instead of the 30+ minutes the
// full per-document existence check takes at this data volume. This just
// tells us the SCALE of the legacy root collections per account - enough to
// decide whether a full backfill is worth doing and roughly how big it is.
//
// Usage:
//   npx tsx tools/audit-message-storage-counts.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const usersSnap = await adminDb.collection("users").get();

  console.log(`Counting for ${usersSnap.size} account(s)...\n`);

  for (const userDoc of usersSnap.docs) {
    const ownerUid = userDoc.id;
    const label = userDoc.data()?.name || userDoc.data()?.email || ownerUid;

    const [messagesCount, repliesCount, conversationsCount] = await Promise.all([
      adminDb.collection("messages").where("ownerUid", "==", ownerUid).count().get(),
      adminDb.collection("replies").where("ownerUid", "==", ownerUid).count().get(),
      adminDb.collection("conversations").where("ownerUid", "==", ownerUid).count().get(),
    ]);

    console.log(`=== ${label} (${ownerUid}) ===`);
    console.log(`  conversations: ${conversationsCount.data().count}`);
    console.log(`  root messages collection: ${messagesCount.data().count}`);
    console.log(`  root replies collection:  ${repliesCount.data().count}`);
    console.log("");
  }

  console.log("Done. Nothing was written, deleted, or downloaded in full.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
