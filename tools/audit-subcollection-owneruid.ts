// READ-ONLY. Writes nothing, deletes nothing.
//
// New hypothesis after ruling out createdAt completeness (see
// audit-subcollection-createdat.ts, which found all 3 reported
// conversations have clean createdAt on every message): the Firestore
// security rule for conversations/{id}/messages/{messageId} is
//   allow read: if resource.data.ownerUid == request.auth.uid;
// Firestore's real behavior for a LIST/query request (not a single get) is
// that if even ONE document among the ones the query would return fails
// this per-document check, the ENTIRE query is rejected with
// permission-denied - it does not just silently omit that one doc.
//
// The Admin SDK bypasses security rules entirely, so the previous
// diagnostic (which used adminDb) would never see this - it would report
// clean data even if the client-side read is completely blocked.
//
// This script checks, for each message doc in the subcollection: does it
// have an `ownerUid` field, and does it match the conversation's own
// ownerUid? Any single mismatch or missing value here would explain why
// the live client query threw and the thread page fell back to "No
// messages yet" even though the data genuinely exists.
//
// Usage:
//   npx tsx tools/audit-subcollection-owneruid.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function phoneDocId(phone: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return e164.replace(/[^\d+]/g, "");
}

async function inspectConversation(adminDb: any, ownerUid: string, phone: string, label: string) {
  const conversationId = `${ownerUid}_${phoneDocId(phone)}`;
  const convoRef = adminDb.collection("conversations").doc(conversationId);
  const convoSnap = await convoRef.get();

  console.log(`\n--- ${label} (${phone}) -> conversations/${conversationId} ---`);
  if (!convoSnap.exists) {
    console.log("  conversation doc itself does not exist.");
    return;
  }

  const msgsSnap = await convoRef.collection("messages").get();
  console.log(`  ${msgsSnap.size} message doc(s) in subcollection`);

  let badCount = 0;
  for (const d of msgsSnap.docs) {
    const data = d.data();
    const msgOwnerUid = data.ownerUid;
    if (msgOwnerUid !== ownerUid) {
      badCount++;
      console.log(
        `  *** MISMATCH: doc ${d.id} has ownerUid=${JSON.stringify(msgOwnerUid)}, expected "${ownerUid}" (backfilledFrom=${data.backfilledFrom || "n/a"}, direction=${data.direction || "?"}, createdAt=${data.createdAt ? "present" : "MISSING"}) ***`
      );
    }
  }
  if (badCount === 0) {
    console.log("  all message docs have correct ownerUid - rules should allow this query.");
  } else {
    console.log(`  ${badCount}/${msgsSnap.size} message doc(s) would fail the security rule check.`);
  }
}

async function scanAccountForOwnerUidGaps(adminDb: any, ownerUid: string, label: string) {
  console.log(`\n=== Broad scan: ${label} (${ownerUid}) ===`);
  const convosSnap = await adminDb.collection("conversations").where("ownerUid", "==", ownerUid).get();
  console.log(`  ${convosSnap.docs.length} conversations to check...`);

  let affectedConversations = 0;
  let totalBadDocs = 0;
  let checked = 0;

  for (const convoDoc of convosSnap.docs) {
    checked++;
    if (checked % 1000 === 0) {
      console.log(`  ...${checked}/${convosSnap.docs.length} checked`);
    }
    const msgsSnap = await convoDoc.ref.collection("messages").get();
    if (msgsSnap.empty) continue;

    let badInThisConvo = 0;
    for (const m of msgsSnap.docs) {
      if (m.data().ownerUid !== ownerUid) badInThisConvo++;
    }
    if (badInThisConvo > 0) {
      affectedConversations++;
      totalBadDocs += badInThisConvo;
      if (affectedConversations <= 15) {
        console.log(`    ${convoDoc.id}: ${badInThisConvo}/${msgsSnap.size} message(s) with wrong/missing ownerUid`);
      }
    }
  }

  console.log(
    `  RESULT: ${affectedConversations} conversation(s) affected, ${totalBadDocs} bad doc(s) total`
  );
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");
  const usersSnap = await adminDb.collection("users").get();
  const owners = usersSnap.docs.map((d: any) => ({
    uid: d.id,
    label: `${d.data()?.name || d.data()?.email || d.id}`,
  }));

  const knownPhones = [
    { phone: "+17012700190", label: "Gregory Daws" },
    { phone: "+18189613285", label: "Brandon Pattillo" },
    { phone: "+19038755300", label: "Jeffrey Scot Clayborn" },
  ];

  console.log("### Targeted inspection of the 3 reported conversations ###");
  for (const owner of owners) {
    for (const kp of knownPhones) {
      const conversationId = `${owner.uid}_${phoneDocId(kp.phone)}`;
      const snap = await adminDb.collection("conversations").doc(conversationId).get();
      if (snap.exists) {
        await inspectConversation(adminDb, owner.uid, kp.phone, `${kp.label} [${owner.label}]`);
      }
    }
  }

  console.log("\n\n### Broad scan across all accounts (this will take a while) ###");
  for (const owner of owners) {
    await scanAccountForOwnerUidGaps(adminDb, owner.uid, owner.label);
  }

  console.log("\nDone. Nothing was written or deleted.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
