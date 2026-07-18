// READ-ONLY. Writes nothing, deletes nothing.
//
// Investigating: /replies/[phone] thread pages load fine on first paint but
// never update live - new inbound replies only show up after a manual
// "Refresh Thread" click. The browser console shows a genuine, reproducible
// "FirebaseError: Missing or insufficient permissions." every time, coming
// from the onSnapshot() LIVE LISTENER on conversations/{id}/messages (not
// from the one-time initial load, which apparently falls back to older data
// sources and silently swallows the same error).
//
// Firestore's rule for that subcollection is:
//   allow read: if resource.data.ownerUid == request.auth.uid;
// For a LIST/query read (which onSnapshot(query(...)) is), if even ONE
// document among the ones the query would return fails this per-document
// check, Firestore rejects the WHOLE query with permission-denied - it does
// not just omit that one doc. This checks every message doc in a given
// conversation's subcollection for a missing/incorrect ownerUid field.
//
// Usage:
//   npx tsx tools/check-thread-listener-permission.ts <ownerUid> <phone>
// Example:
//   npx tsx tools/check-thread-listener-permission.ts SKmaVTN8TjeTayQ9FiuStmNiNLE2 +15168163136

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function phoneDocId(phone: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return e164.replace(/[^\d+]/g, "");
}

async function main() {
  const ownerUid = process.argv[2];
  const phone = process.argv[3];

  if (!ownerUid || !phone) {
    console.error(
      "Usage: npx tsx tools/check-thread-listener-permission.ts <ownerUid> <phone>"
    );
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");

  const conversationId = `${ownerUid}_${phoneDocId(phone)}`;
  const convoRef = adminDb.collection("conversations").doc(conversationId);
  const convoSnap = await convoRef.get();

  console.log(`Conversation: conversations/${conversationId}`);
  if (!convoSnap.exists) {
    console.log("  does NOT exist.");
    process.exit(0);
  }
  console.log(`  ownerUid field on parent doc: ${convoSnap.data()?.ownerUid}`);
  console.log(`  (expected to match request.auth.uid = ${ownerUid} for rules to pass)\n`);

  const msgsSnap = await convoRef.collection("messages").get();
  console.log(`  ${msgsSnap.size} message doc(s) in subcollection\n`);

  let badCount = 0;
  msgsSnap.docs.forEach((d) => {
    const data = d.data();
    const msgOwnerUid = data.ownerUid;
    const ok = msgOwnerUid === ownerUid;
    if (!ok) badCount++;
    console.log(
      `  ${ok ? "OK  " : "BAD *"} ${d.id}: ownerUid=${JSON.stringify(
        msgOwnerUid
      )} direction=${data.direction} createdAt=${
        data.createdAt ? "present" : "MISSING"
      } body=${JSON.stringify(String(data.body || "").slice(0, 40))}`
    );
  });

  console.log(
    `\n${badCount} of ${msgsSnap.size} message doc(s) would fail the security rule check.`
  );
  if (badCount > 0) {
    console.log(
      "This confirms the hypothesis: the live query is rejected wholesale because of these doc(s)."
    );
  } else {
    console.log(
      "All message docs look fine - the permission error must be coming from somewhere else (will need to check further)."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
