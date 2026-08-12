// tools/resend-and-clean-invalid-from-number.ts had a dedupe gap: its
// "eligible to resend" list was built per root failed `messages` doc, not
// per phone number. If a lead had two separate failed 21606 records (two
// original sends that both failed), the script correctly found both as
// individually eligible and resent each one - the customer got the exact
// same text twice in the same run (confirmed on multiple leads, e.g. one
// case where the second copy went out *after* the customer had already
// replied "YES" to the first).
//
// This script finds those duplicate pairs and removes the SECOND copy from
// the UI (root `messages` doc + the matching doc in the conversation's own
// `conversations/{id}/messages` subcollection), keeping the first/earliest
// send as the record of what the customer actually got. The message was
// genuinely delivered by Twilio both times - this only cleans up the
// display, it doesn't un-send anything.
//
// Scope is narrowed to messages with a `resentFromMessageId` field (i.e.
// only ones this resend script itself created), so it can't accidentally
// touch two genuinely-identical messages a user sent on purpose on two
// different occasions.
//
// After deleting a duplicate, if it was the conversation's current
// "last message", the conversation doc's lastMessage/lastMessageAt/
// lastOutboundStatus are recomputed from what's actually left in the
// thread so the /replies list preview doesn't point at a deleted message.
//
// Usage:
//   npx tsx tools/remove-duplicate-resent-messages.ts            (dry run)
//   npx tsx tools/remove-duplicate-resent-messages.ts --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const apply = process.argv.includes("--apply");

  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);
  console.log("Scanning for messages this run's resend script created (resentFromMessageId set)...\n");

  // resentFromMessageId is always a non-empty docId string on these docs -
  // ">" "" matches any non-empty string, so this is a safe "field exists
  // and is truthy" query without needing a composite/!= index.
  const resentSnap = await adminDb
    .collection("messages")
    .where("resentFromMessageId", ">", "")
    .get();

  console.log(`Found ${resentSnap.size} resent message doc(s) total.\n`);

  type Row = {
    docId: string;
    ownerUid: string;
    phone: string;
    body: string;
    sid: string;
    conversationId: string;
    createdAtMs: number;
  };

  const rows: Row[] = resentSnap.docs.map((d) => {
    const data = d.data() || {};
    return {
      docId: d.id,
      ownerUid: String(data.ownerUid || ""),
      phone: String(data.phone || data.to || ""),
      body: String(data.body || "").trim(),
      sid: String(data.sid || data.twilioSid || ""),
      conversationId: String(data.conversationId || ""),
      createdAtMs: typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : 0,
    };
  });

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.ownerUid}|${r.phone}|${r.body}`;
    const arr = groups.get(key) || [];
    arr.push(r);
    groups.set(key, arr);
  }

  const duplicateGroups = Array.from(groups.values()).filter((arr) => arr.length > 1);

  console.log(`Found ${duplicateGroups.length} phone(s) with a duplicate resend (same body, same owner).\n`);

  if (duplicateGroups.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  let toDelete: Row[] = [];
  for (const group of duplicateGroups) {
    group.sort((a, b) => a.createdAtMs - b.createdAtMs);
    const [keep, ...rest] = group;
    console.log(`  phone=${keep.phone} owner=${keep.ownerUid} - keeping ${keep.docId} (${new Date(keep.createdAtMs).toISOString()}), removing ${rest.length} later duplicate(s):`);
    for (const dupe of rest) {
      console.log(`    ${apply ? "Removing" : "Would remove"} ${dupe.docId} (${new Date(dupe.createdAtMs).toISOString()}, sid=${dupe.sid})`);
    }
    toDelete = toDelete.concat(rest);
  }

  console.log(`\nTotal duplicate copies to remove: ${toDelete.length}\n`);

  if (!apply) {
    console.log("DRY RUN - nothing deleted. Re-run with --apply to actually remove these.");
    return;
  }

  let removed = 0;
  let failed = 0;
  const touchedConvoIds = new Set<string>();

  for (const dupe of toDelete) {
    try {
      await adminDb.collection("messages").doc(dupe.docId).delete();

      if (dupe.conversationId && dupe.sid) {
        await adminDb
          .collection("conversations")
          .doc(dupe.conversationId)
          .collection("messages")
          .doc(dupe.sid)
          .delete();
      }

      if (dupe.conversationId) touchedConvoIds.add(dupe.conversationId);

      removed++;
    } catch (err) {
      failed++;
      console.error(`Failed to remove ${dupe.docId}: ${(err as { message?: string })?.message || err}`);
    }
  }

  console.log(`\nRemoved ${removed} duplicate message(s), ${failed} failure(s).\n`);
  console.log(`Recomputing conversation preview for ${touchedConvoIds.size} affected conversation(s)...\n`);

  let recomputed = 0;
  for (const convoId of touchedConvoIds) {
    try {
      const lastMsgSnap = await adminDb
        .collection("conversations")
        .doc(convoId)
        .collection("messages")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (lastMsgSnap.empty) continue;

      const last = lastMsgSnap.docs[0].data() || {};
      await adminDb
        .collection("conversations")
        .doc(convoId)
        .set(
          {
            lastMessage: String(last.body || ""),
            lastDirection: String(last.direction || ""),
            lastMessageAt: last.createdAt,
            ...(last.direction === "outbound"
              ? { lastOutboundAt: last.createdAt, lastOutboundStatus: last.status || "" }
              : {}),
          },
          { merge: true }
        );
      recomputed++;
    } catch (err) {
      console.error(`Failed to recompute preview for ${convoId}: ${(err as { message?: string })?.message || err}`);
    }
  }

  console.log(`Done - recomputed ${recomputed} conversation preview(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
