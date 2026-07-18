// READ-ONLY. Writes nothing, deletes nothing.
//
// Investigates why a single query against conversations/{id}/messages
// ordered by createdAt (desc) came back EMPTY for real conversations that
// have visible message history elsewhere in the app (Gregory Daws
// +17012700190, Brandon Pattillo +18189613285, Jeffrey Scot Clayborn
// +19038755300 confirmed via screenshots).
//
// Firestore excludes a document from a query entirely if it's missing the
// field used in orderBy/where - so if some subcollection message docs lack
// a valid `createdAt` field (wrong type, missing, or null), they'd silently
// vanish from `orderBy("createdAt","desc")` even though the docs exist.
//
// This script, for each target conversation:
//   1. Counts total docs in the subcollection (raw .get(), no orderBy).
//   2. Checks each doc's `createdAt` field: missing, null, wrong type
//      (not a Firestore Timestamp), or valid.
//   3. Runs the EXACT query the thread page uses
//      (orderBy("createdAt","desc").limit(50)) and reports how many docs
//      it returns.
//   4. If there's a gap between (1) and (3), that confirms the hypothesis.
//
// Also runs a broader scan across ALL conversations for each of the 5
// account owners, tallying how many conversations would be affected, so we
// know the true blast radius before attempting any fix.
//
// Usage:
//   npx tsx tools/audit-subcollection-createdat.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const TARGET_CONVERSATIONS: { label: string; conversationId: string }[] = [
  // Filled in dynamically below by phone lookup, but if you know the exact
  // conversation doc IDs already, you can hardcode them here instead.
];

function phoneDocId(phone: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return e164.replace(/[^\d+]/g, "");
}

function describeCreatedAt(v: any): string {
  if (v === undefined) return "MISSING";
  if (v === null) return "NULL";
  if (typeof v?.toDate === "function") return "valid Timestamp";
  if (v?._seconds !== undefined) return "raw Timestamp-like object";
  if (typeof v === "string") return `string ("${v.slice(0, 30)}")`;
  if (typeof v === "number") return `number (${v})`;
  return `unexpected type (${typeof v})`;
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

  const rawSnap = await convoRef.collection("messages").get();
  console.log(`  raw subcollection doc count (no orderBy): ${rawSnap.size}`);

  const tally: Record<string, number> = {};
  for (const d of rawSnap.docs) {
    const data = d.data();
    const desc = describeCreatedAt(data.createdAt);
    tally[desc] = (tally[desc] || 0) + 1;
  }
  console.log("  createdAt field breakdown:", JSON.stringify(tally));

  try {
    const orderedSnap = await convoRef
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    console.log(`  orderBy("createdAt","desc").limit(50) returned: ${orderedSnap.size} docs`);
    if (orderedSnap.size < rawSnap.size) {
      console.log(
        `  *** GAP CONFIRMED: ${rawSnap.size - orderedSnap.size} doc(s) exist but are excluded by the orderBy query ***`
      );
    }
  } catch (e: any) {
    console.log(`  orderBy query THREW an error: ${e?.message || e}`);
  }
}

async function scanAccountForGaps(adminDb: any, ownerUid: string, label: string) {
  console.log(`\n=== Broad scan: ${label} (${ownerUid}) ===`);
  const convosSnap = await adminDb.collection("conversations").where("ownerUid", "==", ownerUid).get();
  console.log(`  ${convosSnap.docs.length} conversations to check...`);

  let affectedConversations = 0;
  let totalBadDocs = 0;
  let checked = 0;

  for (const convoDoc of convosSnap.docs) {
    checked++;
    if (checked % 500 === 0) {
      console.log(`  ...${checked}/${convosSnap.docs.length} checked`);
    }
    const msgsSnap = await convoDoc.ref.collection("messages").get();
    if (msgsSnap.empty) continue;

    let badInThisConvo = 0;
    for (const m of msgsSnap.docs) {
      const createdAt = m.data().createdAt;
      const ok = typeof createdAt?.toDate === "function";
      if (!ok) badInThisConvo++;
    }
    if (badInThisConvo > 0) {
      affectedConversations++;
      totalBadDocs += badInThisConvo;
      if (affectedConversations <= 10) {
        console.log(`    ${convoDoc.id}: ${badInThisConvo}/${msgsSnap.size} messages with bad/missing createdAt`);
      }
    }
  }

  console.log(
    `  RESULT: ${affectedConversations} conversation(s) with at least one bad createdAt doc, ${totalBadDocs} bad doc(s) total`
  );
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  // Known-affected conversations from the user's screenshots. We need the
  // ownerUid for each - Abe owns Gregory Daws (already established earlier
  // this session); Brandon Pattillo and Jeffrey Scot Clayborn ownership
  // will be found via the broad scan below if not Abe's, but try Abe first
  // since these all surfaced on the same account's /replies list.
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
    await scanAccountForGaps(adminDb, owner.uid, owner.label);
  }

  console.log("\nDone. Nothing was written or deleted.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
