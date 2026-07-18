// READ-ONLY. Writes nothing, deletes nothing.
//
// Corrected version: outbound sends (app/api/send-sms/route.ts,
// send-sms/twilio/route.ts, send-reply/route.ts) write the root `messages`
// collection doc with an auto-generated ID and a `sid` FIELD pointing at the
// real Twilio SID - the subcollection doc, by contrast, uses that SID as its
// actual document ID. The first version of this script compared root docs
// by their own ID against the subcollection, which can never match for
// outbound messages by design. This version matches by the `sid` field
// value instead, which is the real link between the two stores.
//
// Inbound messages (app/api/send-sms/twilio/inbound/route.ts) DO use the
// messageSid as the doc ID in both the subcollection and the root `replies`
// collection, so that comparison (by d.id) was already correct - kept as-is
// below for `replies`.
//
// Usage:
//   npx tsx tools/audit-message-storage-overlap.ts            (all accounts)
//   npx tsx tools/audit-message-storage-overlap.ts <ownerUid>  (one account)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

type Tally = {
  ownerLabel: string;
  rootMessagesTotal: number;
  rootMessagesMissingFromSub: number;
  rootMessagesNoSid: number;
  rootRepliesTotal: number;
  rootRepliesMissingFromSub: number;
  exampleMissingMessages: string[];
  exampleMissingReplies: string[];
};

async function auditOwner(adminDb: any, ownerUid: string, ownerLabel: string): Promise<Tally> {
  const tally: Tally = {
    ownerLabel,
    rootMessagesTotal: 0,
    rootMessagesMissingFromSub: 0,
    rootMessagesNoSid: 0,
    rootRepliesTotal: 0,
    rootRepliesMissingFromSub: 0,
    exampleMissingMessages: [],
    exampleMissingReplies: [],
  };

  const BATCH = 25;

  // --- root `messages` (outbound-focused): match by the `sid`/`twilioSid`
  // FIELD, which is the subcollection's doc ID - not by the root doc's own
  // (auto-generated) ID.
  const messagesSnap = await adminDb
    .collection("messages")
    .where("ownerUid", "==", ownerUid)
    .get();
  tally.rootMessagesTotal = messagesSnap.size;

  const msgDocs = messagesSnap.docs;
  for (let i = 0; i < msgDocs.length; i += BATCH) {
    const batch = msgDocs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (d: any) => {
        const data = d.data();
        const conversationId = String(data.conversationId || "").trim();
        const sid = String(data.sid || data.twilioSid || "").trim();
        if (!conversationId || !sid) {
          return { noSid: true, id: d.id };
        }
        const subSnap = await adminDb
          .collection("conversations")
          .doc(conversationId)
          .collection("messages")
          .doc(sid)
          .get();
        return { noSid: false, missing: !subSnap.exists, id: d.id, sid, conversationId };
      })
    );

    for (const r of results) {
      if (r.noSid) {
        tally.rootMessagesNoSid++;
      } else if (r.missing) {
        tally.rootMessagesMissingFromSub++;
        if (tally.exampleMissingMessages.length < 5) {
          tally.exampleMissingMessages.push(`messages/${r.id} (sid=${r.sid}, conversationId=${r.conversationId})`);
        }
      }
    }
  }

  // --- root `replies` (inbound-focused): doc ID IS the message SID in both
  // stores, so comparing by d.id directly is correct here.
  const repliesSnap = await adminDb
    .collection("replies")
    .where("ownerUid", "==", ownerUid)
    .get();
  tally.rootRepliesTotal = repliesSnap.size;

  const replyDocs = repliesSnap.docs;
  for (let i = 0; i < replyDocs.length; i += BATCH) {
    const batch = replyDocs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (d: any) => {
        const data = d.data();
        const conversationId = String(data.conversationId || "").trim();
        if (!conversationId) return { skip: true, id: d.id };
        const subSnap = await adminDb
          .collection("conversations")
          .doc(conversationId)
          .collection("messages")
          .doc(d.id)
          .get();
        return { skip: false, missing: !subSnap.exists, id: d.id, conversationId };
      })
    );

    for (const r of results) {
      if (!r.skip && r.missing) {
        tally.rootRepliesMissingFromSub++;
        if (tally.exampleMissingReplies.length < 5) {
          tally.exampleMissingReplies.push(`replies/${r.id} (conversationId=${r.conversationId})`);
        }
      }
    }
  }

  return tally;
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");
  const arg = process.argv[2];

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

  console.log(`Auditing ${owners.length} account(s)...\n`);

  for (const owner of owners) {
    const tally = await auditOwner(adminDb, owner.uid, owner.label);
    console.log(`=== ${tally.ownerLabel} (${owner.uid}) ===`);
    console.log(
      `  root messages: ${tally.rootMessagesTotal} total, ${tally.rootMessagesMissingFromSub} missing from subcollection, ${tally.rootMessagesNoSid} with no sid/conversationId to check`
    );
    console.log(
      `  root replies:  ${tally.rootRepliesTotal} total, ${tally.rootRepliesMissingFromSub} missing from subcollection`
    );
    if (tally.exampleMissingMessages.length) {
      console.log(`  example missing messages: ${tally.exampleMissingMessages.join(", ")}`);
    }
    if (tally.exampleMissingReplies.length) {
      console.log(`  example missing replies: ${tally.exampleMissingReplies.join(", ")}`);
    }
    console.log("");
  }

  console.log("Done. Nothing was written or deleted.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
