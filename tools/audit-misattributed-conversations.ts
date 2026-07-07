// Read-only audit: finds customer phone numbers that show up as a
// conversation under more than one owning user.
//
// Why this is the right signature to look for: conversationId is built as
// `${uid}_${customerPhone}`. For an outbound-initiated conversation, uid is
// whoever sent the campaign. For an inbound reply, uid is resolved by the
// webhook from the Twilio number that received it. Before the `from`-pinning
// fix, a reply could land on a different user's number than the one that
// actually sent the original message — which creates a SECOND, separate
// conversation doc for that same customer phone under the wrong owner
// (typically with inbound messages but no matching outbound campaign of its
// own). A customer phone appearing under 2+ distinct ownerUids is exactly
// that pattern.
//
// This script only reports — it does not move or delete anything. Deciding
// which owner is the "real" one is a judgment call (usually: whichever one
// has actual outbound campaign history to that number).
//
// Usage: npx tsx tools/audit-misattributed-conversations.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb.collection("conversations").get();
  console.log(`Scanned ${snap.size} conversation docs.\n`);

  const byPhone = new Map<
    string,
    Array<{
      conversationId: string;
      ownerUid: string;
      ownerEmail: string;
      outboundCount: number;
      inboundCount: number;
      hasReply: boolean;
    }>
  >();

  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const phone = toE164(String(data.phone || ""));
    if (!phone) return;

    const list = byPhone.get(phone) || [];
    list.push({
      conversationId: doc.id,
      ownerUid: String(data.ownerUid || ""),
      ownerEmail: String(data.ownerEmail || ""),
      outboundCount: Number(data.outboundCount || 0),
      inboundCount: Number(data.inboundCount || 0),
      hasReply: data.hasReply === true,
    });
    byPhone.set(phone, list);
  });

  let flagged = 0;

  for (const [phone, entries] of byPhone.entries()) {
    const distinctOwners = new Set(entries.map((e) => e.ownerUid));
    if (distinctOwners.size <= 1) continue;

    flagged++;
    console.log(`FLAGGED: ${phone} appears under ${distinctOwners.size} different owners:`);
    entries.forEach((e) => {
      const suspicious = e.outboundCount === 0 && e.inboundCount > 0;
      console.log(
        `  - conversationId=${e.conversationId} owner=${e.ownerEmail || e.ownerUid} ` +
          `outbound=${e.outboundCount} inbound=${e.inboundCount} hasReply=${e.hasReply}` +
          `${suspicious ? "  <-- inbound-only, no outbound campaign: likely the leaked side" : ""}`
      );
    });
    console.log("");
  }

  if (flagged === 0) {
    console.log("No customer phone number appears under more than one owner. No leaked conversations found.");
  } else {
    console.log(`Found ${flagged} phone number(s) split across multiple owners. Review each before merging/reassigning.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
  });
