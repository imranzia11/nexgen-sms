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

  // Two different signals live in this data, and only one of them matters:
  //
  // 1. Benign overlap: the same phone number shows up under multiple
  //    owners, each with their own outbound campaign history to it. This
  //    just means two users' lead lists overlap — normal, expected, not a
  //    bug. Most of what this script used to print was this.
  //
  // 2. The actual leak signature: an owner has ZERO outbound messages to a
  //    number but a real inbound reply anyway. They never sent anything —
  //    so a reply could only have landed on their account if it was
  //    originally sent by a DIFFERENT user whose number Twilio's Messaging
  //    Service pool substituted in (the bug we fixed). This is the only
  //    pattern worth a human looking at.
  let benignOverlapCount = 0;
  let leakSuspects = 0;

  for (const [phone, entries] of byPhone.entries()) {
    const distinctOwners = new Set(entries.map((e) => e.ownerUid));
    if (distinctOwners.size <= 1) continue;

    const suspicious = entries.filter(
      (e) => e.outboundCount === 0 && e.inboundCount > 0
    );

    if (suspicious.length === 0) {
      benignOverlapCount++;
      continue;
    }

    leakSuspects++;
    console.log(`SUSPECTED LEAK: ${phone} appears under ${distinctOwners.size} different owners:`);
    entries.forEach((e) => {
      const flag = e.outboundCount === 0 && e.inboundCount > 0;
      console.log(
        `  - conversationId=${e.conversationId} owner=${e.ownerEmail || e.ownerUid} ` +
          `outbound=${e.outboundCount} inbound=${e.inboundCount} hasReply=${e.hasReply}` +
          `${flag ? "  <-- received a reply despite sending nothing: likely the leaked side" : ""}`
      );
    });
    console.log("");
  }

  console.log(
    `${benignOverlapCount} phone number(s) overlap across owners with normal outbound history on both sides (not a bug, ignored).`
  );

  if (leakSuspects === 0) {
    console.log("No conversations matching the leak signature (reply with zero outbound) were found.");
  } else {
    console.log(`Found ${leakSuspects} phone number(s) matching the leak signature. Review each before reassigning.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
  });
