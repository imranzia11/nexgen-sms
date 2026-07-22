// One-time backfill for the free-text opt-out fix in
// app/api/send-sms/twilio/inbound/route.ts (isOptOutPhrase). That fix
// only protects FUTURE inbound replies - it can't retroactively act on a
// message that already came in and was ignored before the fix existed (a
// real example: a customer replied "Opt out" and was never blocked, since
// the code only ever matched the exact word "STOP"). This scans every past
// inbound reply, finds ones that used a free-text opt-out phrase but were
// never blacklisted, and blocks them the same way the live webhook now
// would: per-owner blacklist, platform-wide block, and cancels any
// follow-up still sitting pending for that number.
//
// The phrase list/normalizer below is DELIBERATELY duplicated from
// route.ts rather than imported - that file imports "next/server", which
// doesn't resolve outside the Next.js runtime, so a standalone script can't
// import it directly. Keep this list in sync with route.ts's optOutPhrases
// if that one ever changes.
//
// Usage:
//   npx tsx tools/backfill-freetext-optout-blocks.ts [--apply]
//
// Without --apply, only prints what WOULD be blocked (dry run).

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function normalizeInboundText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const optOutPhrases = [
  "opt out",
  "optout",
  "opting out",
  "unsubscribe me",
  "remove me",
  "take me off",
  "stop texting me",
  "stop messaging me",
  "stop contacting me",
  "stop sending me",
  "do not text me",
  "do not message me",
  "do not contact me",
  "don t text me",
  "don t message me",
  "don t contact me",
  "no more texts",
  "no more messages",
  "please stop texting",
  "please stop messaging",
];

function isOptOutPhrase(body: string) {
  const text = normalizeInboundText(body);
  return optOutPhrases.some((item) => text.includes(item));
}

async function main() {
  const apply = process.argv.includes("--apply");

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { toE164, phoneDocId } = await import("../lib/phone");

  console.log("Scanning past inbound replies for missed free-text opt-outs...\n");

  const PAGE_SIZE = 500;
  let lastDocId: string | undefined;
  let totalScanned = 0;
  let matchedPhrase = 0;
  let alreadyStopKeyword = 0;
  let alreadyBlacklisted = 0;

  // Dedupe by (ownerUid, phone) - the same conversation can easily have
  // more than one reply that matches (e.g. "stop texting me" said twice),
  // and should only ever be blocked once.
  const toBlock = new Map<
    string,
    {
      ownerUid: string;
      phone: string;
      twilioNumber: string;
      messageSid: string;
      body: string;
      conversationId: string;
    }
  >();

  for (;;) {
    let q = adminDb
      .collection("replies")
      .orderBy("__name__")
      .limit(PAGE_SIZE);

    if (lastDocId) {
      q = q.startAfter(lastDocId);
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      totalScanned++;
      const data = doc.data() || {};
      const body = String(data.body || "");
      const keyword = String(data.keyword || "").toUpperCase();

      // Already correctly handled by the original exact-match logic (STOP
      // was always detected fine, even before this fix) - skip so this
      // never double-processes what's already blocked.
      if (keyword === "STOP" || keyword === "ABUSE") {
        alreadyStopKeyword++;
        continue;
      }

      // Defensive: some very old replies may predate the `keyword` field
      // entirely. Re-check the exact word directly rather than trust a
      // possibly-missing field.
      if (body.trim().toUpperCase() === "STOP") {
        alreadyStopKeyword++;
        continue;
      }

      if (!isOptOutPhrase(body)) continue;

      matchedPhrase++;

      const ownerUid = String(data.ownerUid || "");
      const phone = toE164(String(data.phone || data.from || ""));
      if (!ownerUid || !phone) continue;

      const key = `${ownerUid}_${phoneDocId(phone)}`;
      if (!toBlock.has(key)) {
        toBlock.set(key, {
          ownerUid,
          phone,
          twilioNumber: String(data.twilioNumber || ""),
          messageSid: String(data.sid || doc.id),
          body,
          conversationId: String(data.conversationId || ""),
        });
      }
    }

    lastDocId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGE_SIZE) break;
  }

  console.log(`Replies scanned:                    ${totalScanned}`);
  console.log(`Matched a free-text opt-out phrase: ${matchedPhrase}`);
  console.log(`Already had STOP/ABUSE keyword:      ${alreadyStopKeyword}`);
  console.log(`Unique (owner, phone) pairs found:  ${toBlock.size}\n`);

  if (toBlock.size === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Filter out anything already blacklisted for that specific owner (a
  // later actual STOP reply, or a manual block, may have already covered
  // it) - only touch pairs that genuinely slipped through.
  const plan: Array<{
    ownerUid: string;
    phone: string;
    twilioNumber: string;
    messageSid: string;
    body: string;
    conversationId: string;
  }> = [];

  for (const entry of toBlock.values()) {
    const existingSnap = await adminDb
      .collection("blacklisted_numbers")
      .where("ownerUid", "==", entry.ownerUid)
      .where("phone", "==", entry.phone)
      .limit(1)
      .get();

    const alreadyBlocked =
      !existingSnap.empty &&
      String(existingSnap.docs[0].data()?.status || "").toLowerCase() === "blocked";

    if (alreadyBlocked) {
      alreadyBlacklisted++;
      continue;
    }

    plan.push(entry);
  }

  console.log(`Already blacklisted (skipped):      ${alreadyBlacklisted}`);
  console.log(`Will block:                          ${plan.length}\n`);

  if (plan.length > 0) {
    console.log("Numbers that would be blocked:");
    for (const entry of plan) {
      console.log(
        `  ${entry.phone}  ownerUid=${entry.ownerUid}  body="${entry.body.slice(0, 60)}"`
      );
    }
    console.log("");
  }

  if (!apply) {
    console.log("DRY RUN - nothing written. Re-run with --apply to actually block these.");
    return;
  }

  if (plan.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  let followUpsCancelled = 0;

  for (const entry of plan) {
    const now = FieldValue.serverTimestamp();

    // Per-owner blacklist - same shape as upsertBlacklist() in the inbound
    // webhook.
    const existingSnap = await adminDb
      .collection("blacklisted_numbers")
      .where("ownerUid", "==", entry.ownerUid)
      .where("phone", "==", entry.phone)
      .limit(1)
      .get();

    const payload = {
      ownerUid: entry.ownerUid,
      phone: entry.phone,
      twilioNumber: entry.twilioNumber,
      assignedTwilioNumber: entry.twilioNumber,
      status: "blocked",
      source: "backfill_freetext_optout",
      keyword: "OPT_OUT_PHRASE",
      reason: "opt_out",
      lastBody: entry.body,
      lastKeyword: "OPT_OUT_PHRASE",
      lastMessageSid: entry.messageSid,
      updatedAt: now,
      blockedAt: now,
      unblockedAt: null,
    };

    if (!existingSnap.empty) {
      await existingSnap.docs[0].ref.set(payload, { merge: true });
    } else {
      await adminDb.collection("blacklisted_numbers").add({
        ...payload,
        createdAt: now,
      });
    }

    // Platform-wide backstop - same shape as upsertGlobalBlocklist().
    await adminDb.collection("globalBlacklist").doc(entry.phone).set(
      {
        phone: entry.phone,
        status: "blocked",
        lastKeyword: "OPT_OUT_PHRASE",
        lastTriggeredByUid: entry.ownerUid,
        lastTriggeredByTwilioNumber: entry.twilioNumber,
        lastMessageSid: entry.messageSid,
        lastBody: entry.body,
        blockedAt: now,
        unblockedAt: null,
        updatedAt: now,
      },
      { merge: true }
    );

    // Keep the conversation's own `blocked` flag in sync so /replies shows
    // it as blocked immediately, without waiting for another inbound event.
    if (entry.conversationId) {
      await adminDb
        .collection("conversations")
        .doc(entry.conversationId)
        .set({ blocked: true, blockedAt: now, updatedAt: now }, { merge: true })
        .catch(() => {});
    }

    // Cancel any follow-up still queued for this number - sending one now
    // would directly contradict the opt-out we just backfilled.
    const pendingFollowUpsSnap = await adminDb
      .collection("followUps")
      .where("ownerUid", "==", entry.ownerUid)
      .where("phone", "==", entry.phone)
      .where("status", "==", "pending")
      .get();

    for (const fuDoc of pendingFollowUpsSnap.docs) {
      await fuDoc.ref.update({
        status: "skipped",
        skippedReason: "opt_out_backfill",
        skippedAt: now,
      });
      followUpsCancelled++;
    }
  }

  console.log(
    `Done - blocked ${plan.length} number(s), cancelled ${followUpsCancelled} pending follow-up(s).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
