// READ-ONLY. Writes nothing, deletes nothing.
//
// Investigating: a conversation for +15104186015 ("Benjamin Tarcher") briefly
// appeared under Sunny's "Customer Replied" tab (with an inbound "Yes" reply
// visible), then vanished from every query - including the fully unfiltered
// "All" tab - on both an automated session and Sunny's own real browser.
// That can't be explained by the earlier QUIC/long-polling transport bug
// (already fixed) or by security rules (Admin SDK bypasses rules entirely,
// so if this script can't find the doc either, it genuinely isn't there in
// that form).
//
// This checks, using Admin SDK (ground truth, no client cache/index/rules
// involved):
//   1. The exact conversation doc at `${sunnyUid}_${phoneDocId(phone)}`.
//   2. A collection-wide query for ANY conversation doc with phone/customerPhone
//      matching this number, under ANY owner - in case the inbound webhook
//      wrote it under a different ID than the original outbound send did
//      (e.g. if the original lead's phone was stored without the leading "1"
//      country code, toE164() would produce a different, malformed id like
//      "+5104186015" instead of "+15104186015", so the outbound-created doc
//      and the inbound-created doc could be two totally different documents).
//   3. Same checks for a couple of alternate phone formats.
//   4. If a doc is found, dumps every field plus the messages subcollection.
//
// Usage:
//   npx tsx tools/inspect-benjamin-tarcher.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function phoneDocId(phone: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return e164.replace(/[^\d+]/g, "");
}

async function dumpConversation(adminDb: any, ref: any, label: string) {
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`  [${label}] ${ref.path} -> does NOT exist`);
    return false;
  }
  console.log(`  [${label}] ${ref.path} -> EXISTS`);
  console.log("    fields:", JSON.stringify(snap.data(), null, 2));

  const msgsSnap = await ref.collection("messages").orderBy("createdAt", "asc").get();
  console.log(`    messages subcollection: ${msgsSnap.size} doc(s)`);
  for (const m of msgsSnap.docs) {
    const d = m.data();
    console.log(
      `      - ${m.id}: direction=${d.direction} body=${JSON.stringify(
        String(d.body || "").slice(0, 60)
      )} ownerUid=${d.ownerUid} createdAt=${d.createdAt ? d.createdAt.toDate?.() ?? d.createdAt : "MISSING"}`
    );
  }
  return true;
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const usersSnap = await adminDb.collection("users").get();
  const sunny = usersSnap.docs.find((d: any) => {
    const data = d.data();
    return (
      String(data.email || "").toLowerCase().includes("sunny") ||
      String(data.name || "").toLowerCase().includes("sunny")
    );
  });

  if (!sunny) {
    console.log("Could not find a user matching 'sunny' by name/email. All users:");
    usersSnap.docs.forEach((d: any) =>
      console.log(`  ${d.id}: ${d.data().name || d.data().email}`)
    );
    process.exit(1);
  }

  const sunnyUid = sunny.id;
  console.log(`Sunny's uid: ${sunnyUid} (${sunny.data().name || sunny.data().email})\n`);

  const candidatePhones = [
    "+15104186015",
    "+5104186015", // what toE164() would produce if the raw lead phone had no country code
    "5104186015",
  ];

  console.log("### 1. Exact-ID lookups under Sunny's uid ###");
  let foundAny = false;
  for (const phone of candidatePhones) {
    const id = `${sunnyUid}_${phoneDocId(phone)}`;
    const ref = adminDb.collection("conversations").doc(id);
    const found = await dumpConversation(adminDb, ref, `candidate phone ${phone}`);
    foundAny = foundAny || found;
  }

  console.log("\n### 2. Collection-wide search by phone field (any owner, any id) ###");
  for (const field of ["phone", "customerPhone", "to", "contactPhone"]) {
    for (const phone of candidatePhones) {
      const snap = await adminDb
        .collection("conversations")
        .where(field, "==", phone)
        .get();
      if (!snap.empty) {
        foundAny = true;
        console.log(`  where(${field} == "${phone}") -> ${snap.size} doc(s):`);
        for (const d of snap.docs) {
          console.log(`    id=${d.id} ownerUid=${d.data().ownerUid} blocked=${d.data().blocked} hasReply=${d.data().hasReply} lastDirection=${d.data().lastDirection}`);
        }
      }
    }
  }

  console.log("\n### 3. Collection-wide search by name field 'Benjamin Tarcher' ###");
  const nameSnap = await adminDb
    .collection("conversations")
    .where("name", "==", "Benjamin Tarcher")
    .get();
  if (nameSnap.empty) {
    console.log("  no matches");
  } else {
    foundAny = true;
    for (const d of nameSnap.docs) {
      console.log(`  id=${d.id}`, JSON.stringify(d.data(), null, 2));
    }
  }

  console.log("\n### 4. Root-level 'replies' / 'messages' collections (in case only the raw inbound message survived) ###");
  for (const col of ["replies", "messages"]) {
    const snap = await adminDb
      .collection(col)
      .where("phone", "==", "+15104186015")
      .get()
      .catch(() => ({ empty: true, docs: [] } as any));
    if (!snap.empty) {
      foundAny = true;
      console.log(`  ${col}: ${snap.docs.length} doc(s)`);
      for (const d of snap.docs) {
        console.log(`    id=${d.id}`, JSON.stringify(d.data(), null, 2));
      }
    } else {
      console.log(`  ${col}: no matches on phone field`);
    }
  }

  if (!foundAny) {
    console.log(
      "\nNOTHING FOUND ANYWHERE for this customer, via Admin SDK (bypasses all rules/cache/index quirks)."
    );
    console.log(
      "This means the document that was briefly visible in the UI is genuinely gone from Firestore right now - not a rules/index/display issue."
    );
  }

  console.log("\nDone. Nothing was written or deleted.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
