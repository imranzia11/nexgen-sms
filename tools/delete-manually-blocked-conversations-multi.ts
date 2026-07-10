// Deletes conversations for one or more accounts where the number is
// manually blocked (blacklisted_numbers reason="manual_block" /
// source="manual_block_from_replies" - NOT a customer STOP/opt-out).
// Unlike the earlier Abe-specific script, this is NOT restricted to the
// "Customer Replied" tab - it covers every manually-blocked conversation
// for the given accounts, regardless of reply/waiting/never-replied state.
//
// Does NOT touch blacklisted_numbers - the number stays blocked either
// way. Only deletes the conversation doc, its messages subcollection, and
// matching entries in the root `messages` collection.
//
// PERMANENT. There is no undo. Always run the dry run first and read the
// list before adding --apply.
//
// Usage:
//   npx tsx tools/delete-manually-blocked-conversations-multi.ts <ownerUid1,ownerUid2,...>                       (dry run)
//   npx tsx tools/delete-manually-blocked-conversations-multi.ts <ownerUid1,ownerUid2,...> --apply                (deletes)
//   npx tsx tools/delete-manually-blocked-conversations-multi.ts <ownerUid1,...> --keep=+1XXXXXXXXXX --apply      (also excludes one number, any account)

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
  const ownerArg = process.argv[2];
  const apply = process.argv.includes("--apply");
  const keepArg = process.argv.find((a) => a.startsWith("--keep="));
  const keepPhone = phoneKey(keepArg ? keepArg.split("=")[1] : "+17012700190");

  if (!ownerArg || ownerArg.startsWith("--")) {
    console.error(
      "Usage: npx tsx tools/delete-manually-blocked-conversations-multi.ts <ownerUid1,ownerUid2,...> [--apply] [--keep=+1XXXXXXXXXX]"
    );
    process.exit(1);
  }

  const ownerUids = ownerArg.split(",").map((s) => s.trim()).filter(Boolean);
  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Mode: ${apply ? "APPLY (PERMANENT DELETE)" : "DRY RUN"}`);
  console.log(`Accounts: ${ownerUids.join(", ")}`);
  console.log(`Always kept, any account: ${keepPhone}\n`);

  let totalDeletedConversations = 0;
  let totalDeletedSubMessages = 0;
  let totalDeletedRootMessages = 0;

  for (const ownerUid of ownerUids) {
    console.log(`===== ${ownerUid} =====`);

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

    if (manualBlockedPhones.size === 0) {
      console.log("  No manually-blocked numbers found for this account.\n");
      continue;
    }

    const convSnap = await adminDb
      .collection("conversations")
      .where("ownerUid", "==", ownerUid)
      .get();

    const toDelete: Array<{ id: string; phone: string; name: string; lastMessage: string }> = [];

    convSnap.docs.forEach((doc) => {
      const data = doc.data() || {};
      const phone = phoneKey(
        data.phone || data.customerPhone || data.to || data.contactPhone || ""
      );
      if (!phone) return;
      if (!manualBlockedPhones.has(phone)) return;
      if (phone === keepPhone) return;

      toDelete.push({
        id: doc.id,
        phone,
        name: String(data.name || data.customerName || ""),
        lastMessage: String(data.lastMessage || data.body || "").slice(0, 80),
      });
    });

    if (toDelete.length === 0) {
      console.log("  Manually-blocked numbers exist, but none have a matching conversation doc.\n");
      continue;
    }

    console.log(`  ${toDelete.length} conversation(s) ${apply ? "will be" : "would be"} deleted:`);
    toDelete.forEach((c) => {
      console.log(`    conversations/${c.id}  phone=${c.phone}  name=${c.name || "(none)"}  last="${c.lastMessage || "(none)"}"`);
    });
    console.log("");

    if (!apply) continue;

    for (const c of toDelete) {
      const subSnap = await adminDb
        .collection("conversations")
        .doc(c.id)
        .collection("messages")
        .get();

      const batch = adminDb.batch();
      subSnap.docs.forEach((msgDoc) => {
        batch.delete(msgDoc.ref);
        totalDeletedSubMessages++;
      });
      if (subSnap.size > 0) await batch.commit();

      const rootMsgSnap = await adminDb
        .collection("messages")
        .where("ownerUid", "==", ownerUid)
        .where("phone", "==", c.phone)
        .get();

      const rootBatch = adminDb.batch();
      rootMsgSnap.docs.forEach((msgDoc) => {
        rootBatch.delete(msgDoc.ref);
        totalDeletedRootMessages++;
      });
      if (rootMsgSnap.size > 0) await rootBatch.commit();

      await adminDb.collection("conversations").doc(c.id).delete();
      totalDeletedConversations++;
    }
  }

  if (!apply) {
    console.log("This was a dry run - nothing was deleted. Re-run with --apply once you've checked this list.");
    return;
  }

  console.log("\nDone:");
  console.log(`  ${totalDeletedConversations} conversation(s) deleted`);
  console.log(`  ${totalDeletedSubMessages} message(s) deleted from conversation subcollections`);
  console.log(`  ${totalDeletedRootMessages} message(s) deleted from the root messages collection`);
  console.log(`  blacklisted_numbers left untouched - blocked status unchanged for all numbers`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Delete failed:", err);
    process.exit(1);
  });
