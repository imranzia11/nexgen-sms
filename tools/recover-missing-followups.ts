// WRITES to Firestore (after printing everything first). Recovers a
// campaign that hit the "follow-up scheduled once for the whole list,
// using a stale token" bug (now fixed in app/dashboard/page.tsx): every
// message sent fine, but zero (or very few) followUps docs were ever
// created. This rebuilds them from the actual sent messages, so a
// blocked/invalid number that never got the first text still correctly
// gets no follow-up either.
//
// The follow-up MESSAGE TEXT itself was never stored anywhere for a
// campaign that failed this way (a followUps doc is the only place that
// text normally lives, and none were created) - the best available record
// is users/{ownerUid}.lastFollowUpSettings.followUpMessage, which this
// session's earlier persistence fix saves on every checkbox/template
// interaction. This is printed clearly before anything is written so you
// can confirm it's actually the right text for THIS campaign before
// committing to it.
//
// dueAt is set to each message's own createdAt + followUpHours (the
// ORIGINALLY intended timing), not "now + followUpHours" - for a campaign
// sent a while ago, this means most/all recovered follow-ups will already
// be overdue and get picked up by the very next cron tick (within 15
// min), draining at the cron's normal 200-per-run pace rather than one
// giant simultaneous blast.
//
// Usage:
//   npx tsx tools/recover-missing-followups.ts <ownerUid> "<campaignName>" [--apply]
//
// Without --apply, this only prints what it WOULD create (dry run).
// Pass --apply once you've confirmed the printed follow-up message and
// counts look right.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const positional = process.argv.slice(2).filter((a) => a !== "--apply");
  const ownerUid = positional[0];
  const campaignName = positional[1];
  // The `campaigns` summary doc has turned out to be unreliable for a send
  // that hit this bug (in at least one real case it showed no
  // followUpEnabled/followUpHours at all, even though the checkbox was
  // clearly on - see the "july22 Abe10:46" incident). Rather than trust
  // that doc, accept an explicit hours override here instead.
  const hoursOverrideArg = positional[2];

  if (!ownerUid || !campaignName) {
    console.error(
      'Usage: npx tsx tools/recover-missing-followups.ts <ownerUid> "<campaignName>" [followUpHours] [--apply]'
    );
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { phoneDocId } = await import("../lib/phone");

  const userSnap = await adminDb.collection("users").doc(ownerUid).get();
  if (!userSnap.exists) {
    console.log(`No user doc found for uid ${ownerUid}.`);
    return;
  }
  const userData = userSnap.data() || {};

  const campaignsSnap = await adminDb
    .collection("campaigns")
    .where("ownerUid", "==", ownerUid)
    .where("name", "==", campaignName)
    .get();

  const campaign = campaignsSnap.empty ? {} : campaignsSnap.docs[0].data() || {};

  if (campaignsSnap.empty) {
    console.log(
      `No campaigns doc found for "${campaignName}" - proceeding anyway using the actual sent messages as the source of truth.\n`
    );
  }

  const followUpHours =
    Number(hoursOverrideArg) || Number(campaign.followUpHours || 0);

  if (!followUpHours) {
    console.log(
      `Couldn't determine followUpHours - the campaigns doc doesn't have it, and no override was passed.\n` +
        `Re-run with the correct hours as the third argument, e.g.:\n` +
        `  npx tsx tools/recover-missing-followups.ts ${ownerUid} "${campaignName}" 4`
    );
    return;
  }

  const followUpMessage = String(
    userData.lastFollowUpSettings?.followUpMessage || ""
  ).trim();

  console.log("=== Recovery plan ===");
  console.log(`  campaign:        ${campaignName}`);
  console.log(`  ownerUid:        ${ownerUid}`);
  console.log(`  followUpHours:   ${followUpHours}`);
  console.log(`  followUpMessage: ${followUpMessage || "(EMPTY - stop and check this first!)"}`);
  console.log("");

  if (!followUpMessage) {
    console.log(
      "No follow-up message text found on the user's saved settings. Refusing to " +
        "create follow-ups with empty text - set the correct message manually and " +
        "re-run, or pass it in some other confirmed way before proceeding."
    );
    return;
  }

  // Pull from the root `messages` collection (every successful send writes
  // here - see app/api/send-sms/route.ts), not the original leads list, so
  // a lead that was invalid/blocked and never actually got texted
  // correctly gets no follow-up either.
  const messagesSnap = await adminDb
    .collection("messages")
    .where("ownerUid", "==", ownerUid)
    .where("campaignName", "==", campaignName)
    .where("direction", "==", "outbound")
    .get();

  const blacklistSnap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .get();

  const blockedPhoneKeys = new Set<string>();
  blacklistSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (String(data.status || "").toLowerCase() === "blocked") {
      blockedPhoneKeys.add(phoneDocId(String(data.phone || "")));
    }
  });

  const existingFollowUpsSnap = await adminDb
    .collection("followUps")
    .where("ownerUid", "==", ownerUid)
    .where("campaignName", "==", campaignName)
    .get();

  const alreadyHasFollowUp = new Set(
    existingFollowUpsSnap.docs.map((d) => String(d.data()?.phone || ""))
  );

  // Recovery-specific: unlike the live cron (which sends a follow-up
  // regardless of replies, per an explicit decision made earlier this
  // session), this recovery is happening well after the fact - anyone who
  // has since replied to the original message clearly doesn't need a
  // generic "checking in" text, and sending one anyway would look tone-
  // deaf. Fetched once here via getAll() (one round trip for every
  // conversation involved) rather than a per-message read.
  const conversationIds = Array.from(
    new Set(
      messagesSnap.docs
        .map((d) => String(d.data()?.conversationId || ""))
        .filter(Boolean)
    )
  );

  const repliedConversationIds = new Set<string>();
  if (conversationIds.length > 0) {
    const refs = conversationIds.map((id) => adminDb.collection("conversations").doc(id));
    // getAll() has its own batch-size ceiling well above what a single
    // campaign's conversation count would hit in practice, but chunk it
    // anyway so this never silently breaks if that assumption is wrong.
    const GETALL_CHUNK = 300;
    for (let i = 0; i < refs.length; i += GETALL_CHUNK) {
      const chunkRefs = refs.slice(i, i + GETALL_CHUNK);
      const snaps = await adminDb.getAll(...chunkRefs);
      snaps.forEach((snap) => {
        if (snap.exists && snap.data()?.hasReply === true) {
          repliedConversationIds.add(snap.id);
        }
      });
    }
  }

  const successStatuses = new Set([
    "queued",
    "accepted",
    "scheduled",
    "sending",
    "sent",
    "delivered",
  ]);

  let toCreate = 0;
  let skippedBlocked = 0;
  let skippedAlreadyHasFollowUp = 0;
  let skippedNotSuccessful = 0;
  let skippedNoConversationId = 0;
  let skippedAlreadyReplied = 0;

  const plannedWrites: {
    ref: FirebaseFirestore.DocumentReference;
    data: Record<string, unknown>;
  }[] = [];

  // Dedupe by phone within this pass too - a chunked send could in theory
  // log more than one successful message doc per phone for the same
  // campaign (e.g. a retried chunk); only ever create ONE follow-up per
  // phone regardless.
  const handledThisRun = new Set<string>();

  for (const doc of messagesSnap.docs) {
    const data = doc.data() || {};
    const phone = String(data.phone || data.to || "").trim();
    if (!phone) continue;

    const status = String(data.status || "").toLowerCase();
    if (!successStatuses.has(status)) {
      skippedNotSuccessful++;
      continue;
    }

    if (blockedPhoneKeys.has(phoneDocId(phone))) {
      skippedBlocked++;
      continue;
    }

    if (alreadyHasFollowUp.has(phone) || handledThisRun.has(phone)) {
      skippedAlreadyHasFollowUp++;
      continue;
    }

    const conversationId = String(data.conversationId || "");
    if (!conversationId) {
      skippedNoConversationId++;
      continue;
    }

    if (repliedConversationIds.has(conversationId)) {
      skippedAlreadyReplied++;
      continue;
    }

    const sentAtMs = toDate(data.createdAt)?.getTime() || Date.now();
    const dueAt = new Date(sentAtMs + followUpHours * 60 * 60 * 1000);

    const ref = adminDb.collection("followUps").doc();
    plannedWrites.push({
      ref,
      data: {
        ownerUid,
        conversationId,
        phone,
        twilioNumber: data.twilioNumber || data.from || "",
        messagingServiceSid: data.messagingServiceSid || "",
        campaignName,
        fileId: campaign.uploadId || "",
        fileName: campaign.fileName || "",
        followUpMessage,
        delayHours: followUpHours,
        dueAt,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
        recoveredAt: FieldValue.serverTimestamp(),
        recoveredReason: "stale-token bug - follow-up never scheduled for original send",
      },
    });

    handledThisRun.add(phone);
    toCreate++;
  }

  console.log("=== Result ===");
  console.log(`  messages found for this campaign: ${messagesSnap.size}`);
  console.log(`  will create:                      ${toCreate}`);
  console.log(`  skipped (blocked number):         ${skippedBlocked}`);
  console.log(`  skipped (already has follow-up):  ${skippedAlreadyHasFollowUp}`);
  console.log(`  skipped (send wasn't successful):  ${skippedNotSuccessful}`);
  console.log(`  skipped (no conversationId):       ${skippedNoConversationId}`);
  console.log(`  skipped (already replied):         ${skippedAlreadyReplied}`);
  console.log("");

  if (!apply) {
    console.log(
      `DRY RUN - nothing written. Re-run with --apply to actually create these ${toCreate} followUps doc(s).`
    );
    return;
  }

  if (toCreate === 0) {
    console.log("Nothing to create.");
    return;
  }

  const BATCH_LIMIT = 400;
  let batch = adminDb.batch();
  let opsInBatch = 0;

  for (const { ref, data } of plannedWrites) {
    batch.set(ref, data);
    opsInBatch++;
    if (opsInBatch >= BATCH_LIMIT) {
      await batch.commit();
      batch = adminDb.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) {
    await batch.commit();
  }

  console.log(`Done - created ${toCreate} followUps doc(s). The cron will pick up the overdue ones on its next run (within 15 min).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
