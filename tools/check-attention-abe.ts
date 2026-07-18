// READ-ONLY. Finds every manually-blocked phone on Abe's account, then
// checks each one's conversation doc: does it exist, and does it actually
// belong to Abe (ownerUid match)? This is testing the theory that one bad
// lookup (permission-denied on a conversation that isn't Abe's, or no
// longer exists) was breaking Promise.all() for the whole batch in
// useManuallyBlockedAttention.ts, hiding a perfectly good match elsewhere
// in the same batch.
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const ABE_UID = "8JHmWXe9GldYdtjgvX4KBcWh1423";

function phoneDocId(phone: string) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  const e164 = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return e164.replace(/[^\d+]/g, "");
}

function isManualBlockRecord(data: any) {
  return (
    String(data.reason || "").toLowerCase() === "manual_block" ||
    String(data.source || "").toLowerCase() === "manual_block_from_replies"
  );
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ABE_UID)
    .get();

  const manual = snap.docs.filter((d) => isManualBlockRecord(d.data() || {}));
  console.log(`Total blacklist docs for Abe: ${snap.size}`);
  console.log(`Manually-blocked entries: ${manual.length}`);

  for (const d of manual) {
    const data = d.data();
    const phone = String(data.phone || "").trim();
    const conversationId = `${ABE_UID}_${phoneDocId(phone)}`;
    console.log(`\nphone: ${phone}  (blacklist doc: ${d.id})`);
    console.log(`  status: ${data.status}  reason: ${data.reason}  source: ${data.source}`);
    const convoSnap = await adminDb.collection("conversations").doc(conversationId).get();
    console.log(`  conversation ${conversationId} exists: ${convoSnap.exists}`);
    if (convoSnap.exists) {
      const cdata = convoSnap.data() || {};
      console.log(`    ownerUid matches Abe: ${cdata.ownerUid === ABE_UID}  blocked: ${cdata.blocked}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
