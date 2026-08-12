// Schedules a follow-up (via the same `followUps` collection the app's own
// /api/schedule-follow-up route and send-followups cron already use) for
// every conversation currently in the "Never Replied" bucket
// (hasReply === false) on one account - i.e. leads who never responded to
// the original campaign at all. Built for the specific ask: "send a
// follow-up 12 hours from now to everyone who never replied" after the
// duplicate-resend cleanup, once the Never Replied count was confirmed
// accurate (see tools/recompute-all-conversation-previews.ts).
//
// Mirrors app/api/schedule-follow-up/route.ts exactly: supersedes any
// already-pending follow-up for the same conversation (so nobody ends up
// with two stacked follow-ups), skips numbers blacklisted since, batches
// writes under Firestore's 500-mutation cap. The actual send later happens
// through the existing app/api/cron/send-followups cron - this script only
// queues the `followUps` docs, it does not send anything itself.
//
// Usage:
//   npx tsx tools/schedule-followup-never-replied.ts --email=charles@nexgen.com --delayHours=12 --message="Did you see my text?
//   Reply STOP to opt out, HELP for help."            (dry run, default)
//   npx tsx tools/schedule-followup-never-replied.ts --email=charles@nexgen.com --delayHours=12 --message="..." --apply

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const email = getArg("email").trim().toLowerCase();
  const delayHoursRaw = getArg("delayHours");
  const message = getArg("message").trim();

  if (!email) {
    console.error("Usage: --email=someone@example.com --delayHours=12 --message=\"...\" [--apply]");
    process.exit(1);
  }
  if (!message) {
    console.error("Missing --message.");
    process.exit(1);
  }
  const delayHours = Number(delayHoursRaw);
  if (!delayHours || delayHours <= 0) {
    console.error("Missing/invalid --delayHours.");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { phoneDocId, toE164 } = await import("../lib/phone");

  const userSnap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
  if (userSnap.empty) {
    console.error(`No user found with email ${email}.`);
    process.exit(1);
  }
  const uid = userSnap.docs[0].id;
  const userData = userSnap.docs[0].data() || {};
  const twilioNumber = String(userData.twilioNumber || userData.assignedTwilioNumber || "");

  // Matches the guard in app/api/schedule-follow-up/route.ts, which this
  // script otherwise mirrors - without it, a deactivated/suspended account
  // could still have follow-up SMS queued and later sent by the cron
  // (send-followups doesn't re-check isActive at send time either).
  if (userData.isActive !== true) {
    console.error("This account is not active - refusing to schedule follow-ups.");
    process.exit(1);
  }

  console.log(`Account: ${userData.name || email} (${uid})`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Delay: ${delayHours}h`);
  console.log(`Message: "${message}"\n`);

  const dueAt = new Date(Date.now() + delayHours * 60 * 60 * 1000);
  console.log(`Would fire at: ${dueAt.toISOString()}\n`);

  const [neverRepliedSnap, pendingFollowUpsSnap, blacklistSnap] = await Promise.all([
    adminDb
      .collection("conversations")
      .where("ownerUid", "==", uid)
      .where("hasReply", "==", false)
      .get(),
    adminDb.collection("followUps").where("ownerUid", "==", uid).where("status", "==", "pending").get(),
    adminDb.collection("blacklisted_numbers").where("ownerUid", "==", uid).get(),
  ]);

  console.log(`Found ${neverRepliedSnap.size} "Never Replied" conversation(s) for this account.\n`);

  const pendingByConversation = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  pendingFollowUpsSnap.docs.forEach((d) => {
    const conversationId = String(d.data()?.conversationId || "");
    if (!conversationId) return;
    const list = pendingByConversation.get(conversationId) || [];
    list.push(d);
    pendingByConversation.set(conversationId, list);
  });

  const blockedPhoneKeys = new Set<string>();
  blacklistSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (String(data.status || "").toLowerCase() === "blocked") {
      blockedPhoneKeys.add(phoneDocId(String(data.phone || "")));
    }
  });

  const BATCH_MUTATION_LIMIT = 400;
  let batch = adminDb.batch();
  let opsInBatch = 0;
  let scheduled = 0;
  let blocked = 0;
  let manuallyBlocked = 0;
  let superseded = 0;
  let invalid = 0;

  async function queueOp(op: (b: FirebaseFirestore.WriteBatch) => void) {
    op(batch);
    opsInBatch++;
    if (opsInBatch >= BATCH_MUTATION_LIMIT) {
      if (apply) await batch.commit();
      batch = adminDb.batch();
      opsInBatch = 0;
    }
  }

  for (const doc of neverRepliedSnap.docs) {
    const data = doc.data() || {};
    const phone = toE164(String(data.phone || ""));

    if (!phone) {
      invalid++;
      continue;
    }
    if (blockedPhoneKeys.has(phoneDocId(phone))) {
      blocked++;
      continue;
    }
    if (data.blocked === true) {
      manuallyBlocked++;
      continue;
    }

    const conversationId = doc.id;
    const existingPending = pendingByConversation.get(conversationId) || [];

    for (const existingDoc of existingPending) {
      if (scheduled + superseded < 20) {
        console.log(`  ${apply ? "Superseding" : "Would supersede"} existing pending follow-up for ${phone}`);
      }
      await queueOp((b) =>
        b.update(existingDoc.ref, {
          status: "superseded",
          supersededAt: FieldValue.serverTimestamp(),
          supersededReason: "Replaced by never-replied bulk follow-up.",
        })
      );
      superseded++;
    }

    const ref = adminDb.collection("followUps").doc();
    if (scheduled < 20) {
      console.log(`  ${apply ? "Scheduling" : "Would schedule"} follow-up for ${phone}`);
    }

    await queueOp((b) =>
      b.set(ref, {
        ownerUid: uid,
        conversationId,
        phone,
        twilioNumber,
        messagingServiceSid: userData.messagingServiceSid || "",
        campaignName: "Never-Replied Follow-Up",
        fileId: "",
        fileName: "",
        followUpMessage: message,
        delayHours,
        dueAt,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
      })
    );

    scheduled++;
  }

  if (opsInBatch > 0 && apply) {
    await batch.commit();
  }

  if (scheduled > 20) console.log(`  ... and ${scheduled - 20} more (only first 20 shown)`);

  console.log("\n=== Summary ===");
  console.log(`  ${scheduled} follow-up(s) ${apply ? "scheduled" : "would be scheduled"}`);
  console.log(`  ${superseded} existing pending follow-up(s) ${apply ? "superseded" : "would be superseded"}`);
  console.log(`  ${blocked} skipped (opted out / blacklisted)`);
  console.log(`  ${manuallyBlocked} skipped (manually blocked conversation)`);
  console.log(`  ${invalid} skipped (invalid phone)`);

  if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply to actually schedule these.");
  } else {
    console.log(`\nDone. The existing send-followups cron will pick these up once dueAt passes (~${dueAt.toLocaleString()}).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
