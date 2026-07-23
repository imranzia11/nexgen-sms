// READ-ONLY. Pulls every followUps doc for a specific phone number,
// independent of whether the parent conversations/{id} doc still exists -
// followUps is its own root collection, unaffected by a conversation
// delete. This is the direct evidence for "did the cron send a follow-up
// after the customer had already replied" - status/skippedReason/dueAt/
// sentAt tell the real story regardless of what happened to the
// conversation doc afterward.
//
// Usage:
//   npx tsx tools/check-followup-for-phone.ts <phone> [ownerUid]

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function fmt(value: any): string {
  if (!value) return "(none)";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

async function main() {
  const rawPhone = process.argv[2];
  const ownerUid = process.argv[3] || "";

  if (!rawPhone) {
    console.error("Usage: npx tsx tools/check-followup-for-phone.ts <phone> [ownerUid]");
    process.exit(1);
  }

  const phone = toE164(rawPhone);
  const last10 = phone.replace(/\D/g, "").slice(-10);

  const { adminDb } = await import("../lib/firebaseAdmin");

  console.log(`\nChecking followUps for phone: ${phone}`);
  console.log("=".repeat(60));

  let query = adminDb.collection("followUps") as FirebaseFirestore.Query;
  if (ownerUid) query = query.where("ownerUid", "==", ownerUid);

  const snap = await query.get();
  console.log(`Scanned ${snap.size} followUps doc(s)${ownerUid ? " for this account" : " platform-wide"}.`);

  const matches = snap.docs.filter((d) => {
    const data = d.data();
    const digits = String(data.phone || "").replace(/\D/g, "");
    return last10.length === 10 && digits.endsWith(last10);
  });

  console.log(`\nMatches for this phone: ${matches.length}\n`);

  matches
    .sort((a, b) => {
      const at = a.data().dueAt?.toDate?.()?.getTime?.() || 0;
      const bt = b.data().dueAt?.toDate?.()?.getTime?.() || 0;
      return at - bt;
    })
    .forEach((d) => {
      const data = d.data();
      console.log(`--- followUps/${d.id} ---`);
      console.log(`  phone:          ${data.phone}`);
      console.log(`  ownerUid:       ${data.ownerUid}`);
      console.log(`  conversationId: ${data.conversationId}`);
      console.log(`  status:         ${data.status}`);
      console.log(`  skippedReason:  ${data.skippedReason || "(none)"}`);
      console.log(`  createdAt:      ${fmt(data.createdAt)}`);
      console.log(`  dueAt:          ${fmt(data.dueAt)}`);
      console.log(`  sentAt:         ${fmt(data.sentAt)}`);
      console.log(`  sid:            ${data.sid || "(none)"}`);
      console.log(`  error:          ${data.error || "(none)"}`);
      console.log(`  message:        ${String(data.followUpMessage || "").slice(0, 90)}`);
      console.log("");
    });

  console.log("=".repeat(60));
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
