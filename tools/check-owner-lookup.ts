// Read-only diagnostic: reproduces the exact lookup the inbound webhook does
// (findOwnerByTwilioNumber) for one phone number, and prints exactly why it
// would or wouldn't find an owner. Use this when a test inbound message
// "disappears" with no error.
//
// Usage: npx tsx tools/check-owner-lookup.ts +12314272027

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  const inputRaw = process.argv[2];
  if (!inputRaw) {
    console.error("Usage: npx tsx tools/check-owner-lookup.ts <phone number>");
    process.exit(1);
  }

  const normalizedTo = toE164(inputRaw);
  console.log(`Checking owner lookup for: ${normalizedTo} (raw arg: "${inputRaw}")\n`);

  const { adminDb } = await import("../lib/firebaseAdmin");

  // Step 1: numberAssignments fast path
  console.log(`--- Step 1: numberAssignments/${normalizedTo} ---`);
  const assignmentSnap = await adminDb
    .collection("numberAssignments")
    .doc(normalizedTo)
    .get();

  if (!assignmentSnap.exists) {
    console.log("MISSING. No numberAssignments doc for this exact number.\n");
  } else {
    const assignment = assignmentSnap.data() || {};
    console.log("FOUND:", JSON.stringify(assignment, null, 2));
    const ownerUid = String(assignment.ownerUid || "");

    if (ownerUid) {
      const userDoc = await adminDb.collection("users").doc(ownerUid).get();
      if (!userDoc.exists) {
        console.log(`  -> ownerUid=${ownerUid} but that users/${ownerUid} doc does NOT exist.\n`);
      } else {
        const data = userDoc.data() || {};
        console.log(
          `  -> users/${ownerUid}: email=${data.email || "(none)"} isActive=${data.isActive} (must be === true)`
        );
        if (data.isActive === true) {
          console.log("  -> RESULT: this path WOULD resolve successfully.\n");
        } else {
          console.log("  -> RESULT: BLOCKED — isActive is not exactly boolean true.\n");
        }
      }
    }
  }

  // Step 2: fallback where() queries against users collection
  console.log(`--- Step 2: fallback query users.twilioNumber == "${normalizedTo}" ---`);
  let snap = await adminDb
    .collection("users")
    .where("twilioNumber", "==", normalizedTo)
    .limit(1)
    .get();
  console.log(snap.empty ? "No match." : `Match: uid=${snap.docs[0].id}`);

  console.log(`--- Step 2b: fallback query users.assignedTwilioNumber == "${normalizedTo}" ---`);
  snap = await adminDb
    .collection("users")
    .where("assignedTwilioNumber", "==", normalizedTo)
    .limit(1)
    .get();
  console.log(snap.empty ? "No match." : `Match: uid=${snap.docs[0].id}`);

  // Step 3: dump ALL users with any twilioNumber/assignedTwilioNumber field
  // that "looks like" it might be this number but doesn't strictly match —
  // catches trailing spaces / formatting mismatches.
  console.log(`\n--- Step 3: scanning all users for a near-match (whitespace/format issues) ---`);
  const allUsers = await adminDb.collection("users").get();
  let foundNearMatch = false;

  allUsers.docs.forEach((doc) => {
    const data = doc.data() || {};
    const rawTwilio = String(data.twilioNumber ?? "");
    const rawAssigned = String(data.assignedTwilioNumber ?? "");

    [
      ["twilioNumber", rawTwilio],
      ["assignedTwilioNumber", rawAssigned],
    ].forEach(([field, raw]) => {
      if (!raw) return;
      const normalized = toE164(raw);
      if (normalized === normalizedTo && raw !== normalizedTo) {
        foundNearMatch = true;
        console.log(
          `  uid=${doc.id} field=${field} raw="${raw}" (length ${raw.length}) normalizes to ${normalized} -- MISMATCHES stored value, likely a formatting bug (stray space/char)`
        );
      }
    });
  });

  if (!foundNearMatch) {
    console.log("  None found.");
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Check failed:", err);
    process.exit(1);
  });
