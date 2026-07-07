// Read-only deep dive on the 5 conversations flagged by
// audit-misattributed-conversations.ts. Pulls the full message subcollection
// for every conversation doc tied to each flagged phone number, across all
// owners, so we can see actual message content/timestamps instead of just
// the summary counters — needed to confidently decide how to fix each case
// rather than guessing.
//
// Usage: npx tsx tools/inspect-flagged-conversations.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const FLAGGED_PHONES = [
  "+14045363514",
  "+16103606511",
  "+19079038947",
  "+15613793128",
  "+18505986914",
];

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const allConvos = await adminDb.collection("conversations").get();

  for (const phone of FLAGGED_PHONES) {
    console.log(`\n=================== ${phone} ===================`);

    const matches = allConvos.docs.filter(
      (d) => toE164(String(d.data()?.phone || "")) === phone
    );

    for (const convoDoc of matches) {
      const data = convoDoc.data() || {};
      console.log(
        `\nconversationId=${convoDoc.id}  ownerUid=${data.ownerUid || "(none)"}  ownerEmail=${
          data.ownerEmail || "(none)"
        }  twilioNumber=${data.twilioNumber || "(none)"}  assignedTwilioNumber=${
          data.assignedTwilioNumber || "(none)"
        }`
      );

      const messagesSnap = await convoDoc.ref
        .collection("messages")
        .orderBy("createdAt", "asc")
        .get();

      if (messagesSnap.empty) {
        console.log("  (no messages in subcollection)");
        continue;
      }

      messagesSnap.docs.forEach((m) => {
        const md = m.data() || {};
        const when = md.createdAt?.toDate ? md.createdAt.toDate().toISOString() : "(no timestamp)";
        console.log(
          `  [${when}] dir=${md.direction} from=${md.from} to=${md.to} ownerUid=${md.ownerUid || "(none)"} body="${String(
            md.body || ""
          ).slice(0, 80)}"`
        );
      });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Inspection failed:", err);
    process.exit(1);
  });
