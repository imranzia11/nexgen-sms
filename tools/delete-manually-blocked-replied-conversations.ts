// Deletes conversations that are:
//   1. owned by the given account
//   2. manually blocked (blacklisted_numbers reason="manual_block" /
//      source="manual_block_from_replies" - NOT a customer STOP/opt-out)
//   3. currently showing under the "Customer Replied" tab (hasReply=true,
//      lastDirection="inbound")
//   4. NOT the one phone number you want to keep (default +17012700190)
//
// This does NOT touch blacklisted_numbers - the number stays blocked
// either way. It only deletes the conversation doc, its messages
// subcollection, and matching entries in the root `messages` collection.
//
// PERMANENT. There is no undo. Always run the dry run first and read the
// list before adding --apply.
//
// Usage:
//   npx tsx tools/delete-manually-blocked-replied-conversations.ts <ownerUid>                       (dry run, default)
//   npx tsx tools/delete-manually-blocked-replied-conversations.ts <ownerUid> --apply                (actually deletes)
//   npx tsx tools/delete-manually-blocked-replied-conversations.ts <ownerUid> --keep=+1XXXXXXXXXX    (override the number to keep, default +17012700190)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function phoneKey(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function isManualBlockRecord(data: Record<string, any>) {
  return (
    String(data.reason || "").toLowerCase() === "manual_block" ||
    String(data.source || "").toLowerCase() === "manual_block_from_replies"
  );
}

async function main() {
  const ownerUid = process.argv[2];
  const apply = process.argv.includes("--apply");
  const keepArg = process.argv.find((a) => a.startsWith("--keep="));
  const keepPhone = phoneKey(keepArg ? keepArg.split("=")[1] : "+17012700190");

  if (!ownerUid || ownerUid.startsWith("--")) {
    console.error(
      "Usage: npx tsx tools/delete-manually-blocked-replied-conversations.ts <ownerUid> [--apply] [--keep=+1XXXXXXXXXX]"
    );
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Mode: ${apply ? "APPLY (PERMANENT DELETE)" : "DRY RUN"}`);
  console.log(`Owner: ${ownerUid}`);
  console.log(`Keeping: ${keepPhone}\n`);

  // Same "Customer Replied" criteria the tab itself uses.
  const convSnap = await adminDb
    .collection("conversations")
    .where("ownerUid", "==", ownerUid)
    .where("hasReply", "==", true)
    .where("lastDirection", "==", "inbound")
    .get();

  if (convSnap.empty) {
    console.log("No conversations match hasReply=true/lastDirection=inbound for this owner.");
    return;
  }

  // Load this owner's blacklist once, to know which of these are manual blocks.
  const blacklistSnap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .get();

  const manualBlockedPhones = new Set<string>();
  blacklistSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (
      String(data.status || "").toLowerCase() === "blocked" &&
      isManualBlockRecord(data)
    ) {
      manualBlockedPhones.add(phoneKey(data.phone));
    }
  });

  const toDelete: Array<{ id: string; phone: string; name: string; lastMessage: string }> = [];

  convSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const phone = phoneKey(
      data.phone || data.customerPhone || data.to || data.contactPhone || ""
    );
    if (!phone) return;
    if (!manualBlockedPhones.has(phone)) return; // not a manual block - leave it alone
    if (phone === keepPhone) return; // the one to keep

    toDelete.push({
      id: doc.id,
      phone,
      name: String(data.name || data.customerName || ""),
      lastMessage: String(data.lastMessage || data.body || "").slice(0, 80),
    });
  });

  if (toDelete.length === 0) {
    console.log("Nothing matches the delete criteria. Nothing to do.");
    return;
  }

  console.log(`${toDelete.length} conversation(s) ${apply ? "will be" : "would be"} deleted:\n`);
  toDelete.forEach((c) => {
    console.log(`  conversations/${c.id}`);
    console.log(`    phone: ${c.phone}`);
    console.log(`    name: ${c.name || "(none)"}`);
    console.log(`    last message: ${c.lastMessage || "(none)"}`);
    console.log("");
  });

  if (!apply) {
    console.log("This was a dry run - nothing was deleted. Re-run with --apply once you've checked this list.");
    return;
  }

  let deletedConversations = 0;
  let deletedSubMessages = 0;
  let deletedRootMessages = 0;

  for (const c of toDelete) {
    // Delete the messages subcollection first.
    const subSnap = await adminDb
      .collection("conversations")
      .doc(c.id)
      .collection("messages")
      .get();

    const batch = adminDb.batch();
    subSnap.docs.forEach((msgDoc) => {
      batch.delete(msgDoc.ref);
      deletedSubMessages++;
    });
    if (subSnap.size > 0) await batch.commit();

    // Delete matching root `messages` collection entries for this phone+owner.
    const rootMsgSnap = await adminDb
      .collection("messages")
      .where("ownerUid", "==", ownerUid)
      .where("phone", "==", c.phone)
      .get();

    const rootBatch = adminDb.batch();
    rootMsgSnap.docs.forEach((msgDoc) => {
      rootBatch.delete(msgDoc.ref);
      deletedRootMessages++;
    });
    if (rootMsgSnap.size > 0) await rootBatch.commit();

    // Delete the conversation doc itself.
    await adminDb.collection("conversations").doc(c.id).delete();
    deletedConversations++;
  }

  console.log("\nDone:");
  console.log(`  ${deletedConversations} conversation(s) deleted`);
  console.log(`  ${deletedSubMessages} message(s) deleted from conversation subcollections`);
  console.log(`  ${deletedRootMessages} message(s) deleted from the root messages collection`);
  console.log(`  blacklisted_numbers left untouched - blocked status unchanged for all numbers`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Delete failed:", err);
    process.exit(1);
  });
