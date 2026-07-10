// READ-ONLY diagnostic. Writes nothing.
//
// Why: the "Customer Replied" stat card says 1, but the actual list on
// /replies shows nothing under that tab. The stat count and the visible
// list use two different code paths, so this finds every conversation
// that matches the COUNT query's criteria for "replied", then prints
// everything relevant about it - including the two checks the LIST path
// applies that the COUNT path does NOT: whether `phone` is actually
// populated (an empty/missing phone silently drops a row from the list),
// and whether the number is ALSO present in blacklisted_numbers as
// blocked (the list cross-checks that collection live; the count only
// trusts the conversation doc's own `blocked` field - if those two
// disagree, the count and the list will disagree too).
//
// Usage:
//   npx tsx tools/diagnose-missing-replied-conversation.ts <ownerUid-or-email>
//   npx tsx tools/diagnose-missing-replied-conversation.ts          (lists accounts to choose from)

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function phoneKey(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

async function main() {
  const arg = process.argv[2];
  const { adminDb } = await import("../lib/firebaseAdmin");

  if (!arg) {
    console.log("No account given. Here are the accounts on file:\n");
    const usersSnap = await adminDb.collection("users").get();
    usersSnap.docs.forEach((doc) => {
      const data = doc.data() || {};
      console.log(`  uid=${doc.id}  email=${data.email || "?"}  name=${data.name || "?"}`);
    });
    console.log(
      "\nRe-run with one of those, e.g.:\n  npx tsx tools/diagnose-missing-replied-conversation.ts <uid-or-email>"
    );
    return;
  }

  let ownerUid = arg;
  if (arg.includes("@")) {
    const byEmail = await adminDb
      .collection("users")
      .where("email", "==", arg.trim())
      .limit(1)
      .get();
    if (byEmail.empty) {
      console.error(`No user found with email ${arg}`);
      process.exit(1);
    }
    ownerUid = byEmail.docs[0].id;
  }

  console.log(`Checking ownerUid=${ownerUid}\n`);

  // Same base + "replied" filters the stat card's count query uses.
  const snap = await adminDb
    .collection("conversations")
    .where("ownerUid", "==", ownerUid)
    .where("blocked", "==", false)
    .where("hasReply", "==", true)
    .where("lastDirection", "==", "inbound")
    .get();

  console.log(`Found ${snap.size} conversation doc(s) matching the count query's filters.\n`);

  if (snap.empty) {
    console.log("Nothing matches - the count itself may be stale or wrong. Nothing further to check here.");
    return;
  }

  // Load this owner's real blacklist once, same as the list page does.
  const blacklistSnap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .get();

  const blockedPhones = new Set<string>();
  blacklistSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (String(data.status || "").toLowerCase() === "blocked") {
      blockedPhones.add(phoneKey(data.phone));
    }
  });

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const phone = String(
      data.phone || data.customerPhone || data.to || data.contactPhone || ""
    ).trim();
    const key = phoneKey(phone);

    console.log(`--- conversations/${doc.id} ---`);
    console.log(`  phone field raw: ${JSON.stringify(phone)} ${!key ? "  <-- EMPTY/MISSING: this alone would hide it from the list" : ""}`);
    console.log(`  blocked (on doc): ${data.blocked}`);
    console.log(`  pinned: ${data.pinned === true}`);
    console.log(`  hasReply: ${data.hasReply}`);
    console.log(`  lastDirection: ${data.lastDirection}`);
    console.log(`  lastMessageAt: ${data.lastMessageAt ? "present" : "MISSING"}`);
    console.log(`  updatedAt: ${data.updatedAt ? "present" : "missing"}`);
    console.log(`  createdAt: ${data.createdAt ? "present" : "missing"}`);
    console.log(
      `  actually in blacklisted_numbers as blocked: ${
        key ? blockedPhones.has(key) : "n/a (no phone to check)"
      } ${
        key && blockedPhones.has(key)
          ? "  <-- MISMATCH: doc says blocked=false but the real blacklist says blocked. The list correctly hides this; the count incorrectly includes it."
          : ""
      }`
    );
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Diagnostic failed:", err);
    process.exit(1);
  });
