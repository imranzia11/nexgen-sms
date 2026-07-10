// Diagnostic: for a given phone number (and optionally an ownerUid), prints
// exactly what's in blacklisted_numbers, globalBlacklist, and the matching
// conversations/{ownerUid}_{phone} doc - so we can see directly whether a
// STOP reply that's showing up somewhere it shouldn't (e.g. still counted
// as "Customer Replied") is a missing blacklist entry (STOP never got
// recorded) or a display bug (blacklist entry exists but isn't being
// honored somewhere).
//
// Usage:
//   npx tsx tools/check-stop-blacklist-status.ts +12024006948
//   npx tsx tools/check-stop-blacklist-status.ts +12024006948 <ownerUid>

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  const rawPhone = process.argv[2];
  const ownerUidArg = process.argv[3];

  if (!rawPhone) {
    console.error("Usage: npx tsx tools/check-stop-blacklist-status.ts <phone> [ownerUid]");
    process.exit(1);
  }

  const phone = toE164(rawPhone);
  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`Checking phone: ${phone}\n`);

  // 1. Global blacklist (platform-wide, doc ID = phone)
  const globalDoc = await adminDb.collection("globalBlacklist").doc(phone).get();
  console.log("--- globalBlacklist ---");
  if (globalDoc.exists) {
    console.log(JSON.stringify(globalDoc.data(), null, 2));
  } else {
    console.log("(no document - this number has NEVER triggered the global blocklist)");
  }

  // 2. Per-owner blacklisted_numbers entries (could be more than one if
  // multiple owners have texted this number)
  console.log("\n--- blacklisted_numbers (per-owner) ---");
  const blSnap = await adminDb
    .collection("blacklisted_numbers")
    .where("phone", "==", phone)
    .get();

  if (blSnap.empty) {
    console.log("(no documents at all for this phone number, for ANY owner)");
  } else {
    blSnap.docs.forEach((doc) => {
      console.log(`doc ${doc.id}:`, JSON.stringify(doc.data(), null, 2));
    });
  }

  // 3. Matching conversation doc(s)
  console.log("\n--- conversations (matching this phone) ---");
  const convSnap = await adminDb
    .collection("conversations")
    .where("phone", "==", phone)
    .get();

  if (convSnap.empty) {
    console.log("(no conversation documents found with this exact phone field)");
  } else {
    convSnap.docs.forEach((doc) => {
      const data = doc.data() || {};
      console.log(`doc ${doc.id}:`, {
        ownerUid: data.ownerUid,
        hasReply: data.hasReply,
        lastDirection: data.lastDirection,
        blocked: data.blocked,
        lastMessage: data.lastMessage,
        status: data.status,
      });
    });
  }

  // 4. If an ownerUid was given, check the exact recent inbound message(s)
  // from this number to that owner's conversation, to see the raw body /
  // whether it was ever classified as a STOP.
  if (ownerUidArg) {
    console.log(`\n--- recent messages for ownerUid=${ownerUidArg} ---`);
    const convoId = `${ownerUidArg}_${phone.replace(/[^\d+]/g, "")}`;
    const msgsSnap = await adminDb
      .collection("conversations")
      .doc(convoId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();

    if (msgsSnap.empty) {
      console.log(`(no messages subcollection docs under conversations/${convoId})`);
    } else {
      msgsSnap.docs.forEach((doc) => {
        const data = doc.data() || {};
        console.log(`msg ${doc.id}:`, {
          direction: data.direction,
          body: data.body,
          status: data.status,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
        });
      });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Check failed:", err);
    process.exit(1);
  });
