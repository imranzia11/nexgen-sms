// DRY RUN BY DEFAULT. Pass --apply to actually write anything.
//
// Copies messages found only in the legacy root `messages`/`replies`
// collections into the real source of truth, conversations/{id}/messages -
// COPY ONLY, never deletes or modifies the original root-collection docs.
// Nothing currently visible in the app disappears; this only adds data.
//
// Three categories, based on the audit (tools/audit-message-storage-overlap.ts):
//
//   1. root `replies` docs missing from the subcollection - these always
//      have a conversationId (set by the inbound webhook at write time) and
//      use the message SID as their own doc ID, matching the subcollection's
//      ID scheme exactly. Copied to conversations/{conversationId}/messages/{sid}.
//
//   2. root `messages` docs that DO have a sid + conversationId but are
//      still missing (found exactly 1 across all 5 accounts in the audit) -
//      same treatment, copied to conversations/{conversationId}/messages/{sid}.
//
//   3. root `messages` docs with NEITHER sid nor conversationId - these are
//      all failed/blocked send attempts (confirmed via tools/sample-no-sid-
//      messages.ts: status "failed"/"blocked", sid: "", no conversationId
//      field at all). The current thread page only ever surfaces these
//      through a fallback match on the `to` phone number, and only when a
//      real `conversations/{id}` document already exists for that phone
//      (from some other successful send or reply) - if no such conversation
//      exists, this record isn't reachable in the UI today regardless. So:
//      derive conversationId from ownerUid + phone, and ONLY copy the
//      message in if that conversation document already exists. Skipped
//      otherwise - deliberately NOT creating new conversations that were
//      never visible before, since that would invent new UI surface area
//      rather than preserve what already exists.
//
//      Doc ID for this category: `legacy_{rootDocId}` (prefixed, since
//      there's no real Twilio SID to use) - guarantees this is safe to
//      re-run without creating duplicates.
//
// Usage:
//   npx tsx tools/backfill-legacy-messages-to-subcollection.ts              (dry run, all accounts)
//   npx tsx tools/backfill-legacy-messages-to-subcollection.ts <ownerUid>   (dry run, one account)
//   npx tsx tools/backfill-legacy-messages-to-subcollection.ts --apply
//   npx tsx tools/backfill-legacy-messages-to-subcollection.ts <ownerUid> --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function phoneDocId(phone: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return e164.replace(/[^\d+]/g, "");
}

// One transient DEADLINE_EXCEEDED on a single doc used to kill the entire
// run (Abe's account crashed partway through with 33,000/49,748 messages
// still unchecked). Retrying a couple of times, and catching+logging
// instead of throwing on final failure, means one flaky network blip skips
// just that one doc (it'll get picked up on the next re-run, since this
// whole script is safe to re-run - it only ever checks-then-writes) rather
// than aborting everything after it.
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLast = i === attempts - 1;
      console.warn(`  (retry ${i + 1}/${attempts} failed for ${label}: ${error?.message || error})`);
      if (isLast) {
        console.warn(`  giving up on ${label} for this run - it'll be retried next time you run the script.`);
        return undefined;
      }
    }
  }
  return undefined;
}

async function processOwner(adminDb: any, ownerUid: string, label: string, apply: boolean) {
  let repliesCopied = 0;
  let repliesSkippedAlreadyPresent = 0;
  let messagesCopied = 0;
  let legacyCopied = 0;
  let legacySkippedNoConversation = 0;

  const BATCH = 25;

  // --- Category 1: root `replies` missing from subcollection ---
  const repliesSnap = await adminDb
    .collection("replies")
    .where("ownerUid", "==", ownerUid)
    .get();

  console.log(`  [${label}] checking ${repliesSnap.docs.length} replies...`);
  for (let i = 0; i < repliesSnap.docs.length; i += BATCH) {
    if (i > 0 && i % 500 === 0) {
      console.log(`  [${label}] replies: ${i}/${repliesSnap.docs.length} checked`);
    }
    const batch = repliesSnap.docs.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (d: any) => {
        const data = d.data();
        const conversationId = String(data.conversationId || "").trim();
        if (!conversationId) return;

        const subRef = adminDb
          .collection("conversations")
          .doc(conversationId)
          .collection("messages")
          .doc(d.id);
        const subSnap: any = await withRetry<any>(() => subRef.get(), `replies/${d.id} (get)`);
        if (!subSnap) return; // gave up after retries - will retry next run
        if (subSnap.exists) {
          repliesSkippedAlreadyPresent++;
          return;
        }

        if (apply) {
          const ok = await withRetry(
            () => subRef.set({ ...data, backfilledFrom: "replies", backfilledAt: new Date() }),
            `replies/${d.id} (set)`
          );
          if (ok === undefined) return; // failed - not counted as copied, retry next run
        }
        repliesCopied++;
      })
    );
  }

  // --- Category 2 & 3: root `messages` ---
  const messagesSnap = await adminDb
    .collection("messages")
    .where("ownerUid", "==", ownerUid)
    .get();

  console.log(`  [${label}] checking ${messagesSnap.docs.length} messages...`);
  for (let i = 0; i < messagesSnap.docs.length; i += BATCH) {
    if (i > 0 && i % 500 === 0) {
      console.log(`  [${label}] messages: ${i}/${messagesSnap.docs.length} checked`);
    }
    const batch = messagesSnap.docs.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (d: any) => {
        const data = d.data();
        const sid = String(data.sid || data.twilioSid || "").trim();
        const conversationId = String(data.conversationId || "").trim();

        if (sid && conversationId) {
          // Category 2
          const subRef = adminDb
            .collection("conversations")
            .doc(conversationId)
            .collection("messages")
            .doc(sid);
          const subSnap: any = await withRetry<any>(() => subRef.get(), `messages/${d.id} (get)`);
          if (!subSnap) return;
          if (subSnap.exists) return;

          if (apply) {
            const ok = await withRetry(
              () => subRef.set({ ...data, backfilledFrom: "messages", backfilledAt: new Date() }),
              `messages/${d.id} (set)`
            );
            if (ok === undefined) return;
          }
          messagesCopied++;
          return;
        }

        if (!sid && !conversationId) {
          // Category 3 - derive conversationId, only copy if that
          // conversation already exists (never invent new UI surface area).
          const phone = String(data.to || data.phone || "").trim();
          if (!phone) return;
          const derivedConvoId = `${ownerUid}_${phoneDocId(phone)}`;

          const convoSnap: any = await withRetry<any>(
            () => adminDb.collection("conversations").doc(derivedConvoId).get(),
            `conversations/${derivedConvoId} (get)`
          );
          if (!convoSnap) return;
          if (!convoSnap.exists) {
            legacySkippedNoConversation++;
            return;
          }

          const subRef = adminDb
            .collection("conversations")
            .doc(derivedConvoId)
            .collection("messages")
            .doc(`legacy_${d.id}`);
          const subSnap: any = await withRetry<any>(() => subRef.get(), `messages-legacy/${d.id} (get)`);
          if (!subSnap) return;
          if (subSnap.exists) return;

          if (apply) {
            const ok = await withRetry(
              () =>
                subRef.set({
                  ...data,
                  conversationId: derivedConvoId,
                  backfilledFrom: "messages-legacy-no-sid",
                  backfilledAt: new Date(),
                }),
              `messages-legacy/${d.id} (set)`
            );
            if (ok === undefined) return;
          }
          legacyCopied++;
        }
      })
    );
  }

  console.log(`=== ${label} (${ownerUid}) ===`);
  console.log(`  replies -> subcollection: ${repliesCopied} ${apply ? "copied" : "would copy"} (${repliesSkippedAlreadyPresent} already present)`);
  console.log(`  messages (sid+conversationId) -> subcollection: ${messagesCopied} ${apply ? "copied" : "would copy"}`);
  console.log(`  messages (legacy, no sid) -> subcollection: ${legacyCopied} ${apply ? "copied" : "would copy"}, ${legacySkippedNoConversation} skipped (no matching conversation exists)`);
  console.log("");
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const arg = args.find((a) => a !== "--apply");

  console.log(apply ? "*** APPLY MODE - this will write data ***\n" : "Dry run - nothing will be written.\n");

  let owners: { uid: string; label: string }[] = [];

  if (arg) {
    owners = [{ uid: arg, label: arg }];
  } else {
    const usersSnap = await adminDb.collection("users").get();
    owners = usersSnap.docs.map((d: any) => ({
      uid: d.id,
      label: `${d.data()?.name || d.data()?.email || d.id}`,
    }));
  }

  for (const owner of owners) {
    await processOwner(adminDb, owner.uid, owner.label, apply);
  }

  console.log(apply ? "Done - data written." : "Done - dry run only, nothing written. Re-run with --apply to actually copy.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
