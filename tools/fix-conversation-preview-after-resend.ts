// resend-and-clean-invalid-from-number.ts and resend-failed-auth-messages.ts
// both write to conversations/{id} on every resend with:
//
//   status: existingConvo.hasReply === true ? "replied" : "awaiting_reply",
//   lastDirection: "outbound",
//
// The `status` write correctly checks hasReply first - but `lastDirection`
// is unconditional. If a customer had already replied AFTER the original
// failed send but BEFORE the resend ran, the conversation gets permanently
// mislabeled: the /replies "Waiting for Customer" tab filters on
// `hasReply == true AND lastDirection == "outbound"` (not on `status`), so
// these conversations got stuck showing "Waiting for Customer" even though
// the customer already replied and is the one actually being waited on.
//
// This script finds every conversation that had at least one resent
// message (root `messages` doc with resentFromMessageId set - covers both
// resend scripts) and recomputes lastMessage/lastDirection/lastMessageAt/
// hasReply/status straight from the TRUE latest message actually sitting
// in that conversation's own thread subcollection - the source of truth,
// unaffected by which script last happened to touch the parent doc.
//
// Safe to re-run - a conversation whose fields are already correct is
// simply overwritten with the same values.
//
// Usage:
//   npx tsx tools/fix-conversation-preview-after-resend.ts            (dry run)
//   npx tsx tools/fix-conversation-preview-after-resend.ts --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// Firestore Timestamps compare by reference, not value - use .isEqual()
// when both sides are real Timestamps, otherwise fall back to a loose
// equality check (covers the "both missing/undefined" case).
function timestampsEqual(a: unknown, b: unknown): boolean {
  const aHasIsEqual = typeof (a as { isEqual?: unknown })?.isEqual === "function";
  if (aHasIsEqual && b) {
    try {
      return (a as { isEqual: (other: unknown) => boolean }).isEqual(b);
    } catch {
      return false;
    }
  }
  return a === b;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);
  console.log("Finding every conversation touched by a resend...\n");

  const resentSnap = await adminDb
    .collection("messages")
    .where("resentFromMessageId", ">", "")
    .get();

  const convoIds = new Set<string>();
  for (const doc of resentSnap.docs) {
    const conversationId = String(doc.data()?.conversationId || "");
    if (conversationId) convoIds.add(conversationId);
  }

  console.log(`Found ${convoIds.size} unique conversation(s) with at least one resent message.\n`);

  let fixed = 0;
  let alreadyCorrect = 0;
  let skippedNoMessages = 0;
  let failed = 0;

  for (const convoId of convoIds) {
    try {
      const convoRef = adminDb.collection("conversations").doc(convoId);
      const [convoSnap, lastMsgSnap] = await Promise.all([
        convoRef.get(),
        convoRef.collection("messages").orderBy("createdAt", "desc").limit(1).get(),
      ]);

      if (lastMsgSnap.empty) {
        skippedNoMessages++;
        continue;
      }

      const convoData = convoSnap.exists ? convoSnap.data() || {} : {};
      const last = lastMsgSnap.docs[0].data() || {};
      const trueLastDirection = String(last.direction || "");
      const trueHasReply = trueLastDirection === "inbound" || convoData.hasReply === true;
      const trueStatus = trueHasReply ? "replied" : "awaiting_reply";
      const trueLastMessage = String(last.body || "");

      // Also compare lastMessage/lastMessageAt, not just
      // direction/status/hasReply - a conversation whose direction/status/
      // hasReply already happen to be correct but whose preview TEXT is
      // stale (e.g. it pointed at a message a cleanup script later
      // deleted) was otherwise being skipped as "already correct" and
      // never actually fixed.
      const alreadyMatches =
        convoData.lastDirection === trueLastDirection &&
        convoData.status === trueStatus &&
        convoData.hasReply === trueHasReply &&
        convoData.lastMessage === trueLastMessage &&
        timestampsEqual(convoData.lastMessageAt, last.createdAt);

      if (alreadyMatches) {
        alreadyCorrect++;
        continue;
      }

      console.log(
        `${apply ? "Fixing" : "Would fix"} conversations/${convoId}: lastDirection "${convoData.lastDirection}"->"${trueLastDirection}", status "${convoData.status}"->"${trueStatus}", hasReply ${convoData.hasReply}->${trueHasReply}`
      );

      if (apply) {
        const update: Record<string, unknown> = {
          lastMessage: String(last.body || ""),
          lastDirection: trueLastDirection,
          lastMessageAt: last.createdAt,
          hasReply: trueHasReply,
          status: trueStatus,
        };
        if (trueLastDirection === "outbound") {
          update.lastOutboundAt = last.createdAt;
          update.lastOutboundStatus = last.status || "";
        }
        await convoRef.set(update, { merge: true });
      }

      fixed++;
    } catch (err) {
      failed++;
      console.error(`Failed on conversations/${convoId}: ${(err as { message?: string })?.message || err}`);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`  ${fixed} conversation(s) ${apply ? "fixed" : "would be fixed"}`);
  console.log(`  ${alreadyCorrect} already correct`);
  console.log(`  ${skippedNoMessages} skipped (empty thread)`);
  console.log(`  ${failed} failure(s)`);

  if (!apply && fixed > 0) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to actually fix these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
