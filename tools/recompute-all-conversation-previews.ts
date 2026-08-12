// The /replies stat cards (Customer Replied, Waiting for Customer, Never
// Replied) are server-side count queries keyed off each conversation doc's
// own `hasReply` + `lastDirection` fields (see app/replies/page.tsx). Those
// fields are supposed to always mirror whatever the actual latest message
// in that conversation's own `conversations/{id}/messages` subcollection
// is - but several write paths (resend scripts, possibly others) have at
// different times overwritten them incorrectly, so a live account's counts
// can drift badly out of sync with reality: e.g. observed "All Sent SMS:
// 741" but "Customer Replied: 0" - meaning hundreds of conversations don't
// match ANY of the three buckets, which only happens if their
// hasReply/lastDirection fields hold something other than the expected
// true/false + "inbound"/"outbound" values.
//
// This is the broad version of tools/fix-conversation-preview-after-resend.ts
// (which only touched conversations a resend script had specifically
// hit) - this one walks EVERY conversation doc and recomputes
// lastMessage/lastDirection/lastMessageAt/hasReply/status straight from
// the true latest message in its own thread subcollection, which is the
// actual source of truth no matter which script last wrote the wrong
// thing to the parent doc.
//
// Optional --email=someone@example.com scopes this to one account's
// conversations only (matches the pattern used by the resend tools). Runs
// against ALL conversations if omitted.
//
// Safe to re-run - a conversation whose fields are already correct is
// simply left as-is (no write).
//
// Usage:
//   npx tsx tools/recompute-all-conversation-previews.ts                          (dry run, all accounts)
//   npx tsx tools/recompute-all-conversation-previews.ts --email=charles@nexgen.com --apply
//   npx tsx tools/recompute-all-conversation-previews.ts --apply                  (all accounts, writes for real)

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

const PAGE_SIZE = 300;
const CONCURRENCY = 20;

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const emailArg = process.argv.find((a) => a.startsWith("--email="));
  const email = emailArg ? emailArg.split("=")[1].trim().toLowerCase() : "";

  const { adminDb } = await import("../lib/firebaseAdmin");

  let ownerUid = "";
  if (email) {
    const userSnap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
    if (userSnap.empty) {
      console.error(`No user found with email ${email}.`);
      process.exit(1);
    }
    ownerUid = userSnap.docs[0].id;
    console.log(`Scoping to account: ${email} (${ownerUid})`);
  } else {
    console.log("Scoping to ALL accounts.");
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  let scanned = 0;
  let fixed = 0;
  let alreadyCorrect = 0;
  let emptyThread = 0;
  let failed = 0;

  // Running tallies of what the counts SHOULD be, so you can compare
  // against the /replies stat cards after this finishes.
  let trueCustomerReplied = 0;
  let trueWaitingForCustomer = 0;
  let trueNeverReplied = 0;

  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (;;) {
    // When scoped to one account, filter with a real `.where("ownerUid",
    // "==", ownerUid)` on the query itself instead of fetching every page
    // of the ENTIRE conversations collection and discarding most of it in
    // memory - matters once this collection has many accounts' worth of
    // conversations in it.
    let q: FirebaseFirestore.Query = adminDb.collection("conversations");
    if (ownerUid) q = q.where("ownerUid", "==", ownerUid);
    q = q.orderBy("__name__").limit(PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    const docsThisPage = snap.docs;

    await inBatches(docsThisPage, CONCURRENCY, async (doc) => {
      scanned++;
      const convoId = doc.id;
      const convoData = doc.data() || {};

      try {
        const lastMsgSnap = await doc.ref.collection("messages").orderBy("createdAt", "desc").limit(1).get();

        if (lastMsgSnap.empty) {
          emptyThread++;
          return;
        }

        const last = lastMsgSnap.docs[0].data() || {};
        const trueLastDirection = String(last.direction || "");
        const trueHasReply = trueLastDirection === "inbound" || convoData.hasReply === true;
        const trueStatus = trueHasReply ? "replied" : "awaiting_reply";
        const trueLastMessage = String(last.body || "");

        if (trueHasReply && trueLastDirection === "inbound") trueCustomerReplied++;
        else if (trueHasReply && trueLastDirection === "outbound") trueWaitingForCustomer++;
        else if (!trueHasReply) trueNeverReplied++;

        // Also compare lastMessage/lastMessageAt, not just
        // direction/status/hasReply - otherwise a conversation with a
        // stale preview TEXT (pointing at a message a cleanup script later
        // deleted) but coincidentally-correct direction/status/hasReply
        // was being skipped as "already correct" and never actually fixed.
        const alreadyMatches =
          convoData.lastDirection === trueLastDirection &&
          convoData.status === trueStatus &&
          convoData.hasReply === trueHasReply &&
          convoData.lastMessage === trueLastMessage &&
          timestampsEqual(convoData.lastMessageAt, last.createdAt);

        if (alreadyMatches) {
          alreadyCorrect++;
          return;
        }

        if (fixed < 30) {
          console.log(
            `${apply ? "Fixing" : "Would fix"} conversations/${convoId}: lastDirection "${convoData.lastDirection}"->"${trueLastDirection}", status "${convoData.status}"->"${trueStatus}", hasReply ${convoData.hasReply}->${trueHasReply}`
          );
        }

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
          await doc.ref.set(update, { merge: true });
        }

        fixed++;
      } catch (err) {
        failed++;
        console.error(`Failed on conversations/${convoId}: ${(err as { message?: string })?.message || err}`);
      }
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }

  if (fixed > 30) console.log(`... and ${fixed - 30} more (only first 30 shown)`);

  console.log("\n=== Summary ===");
  console.log(`  ${scanned} conversation(s) scanned`);
  console.log(`  ${fixed} ${apply ? "fixed" : "would be fixed"}`);
  console.log(`  ${alreadyCorrect} already correct`);
  console.log(`  ${emptyThread} skipped (empty thread)`);
  console.log(`  ${failed} failure(s)`);
  console.log("\n=== True counts (what the stat cards should show once applied) ===");
  console.log(`  Customer Replied:    ${trueCustomerReplied}`);
  console.log(`  Waiting for Customer: ${trueWaitingForCustomer}`);
  console.log(`  Never Replied:        ${trueNeverReplied}`);

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
