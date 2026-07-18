// READ-ONLY. Prints a handful of the root `messages` docs that had no
// sid/conversationId, so we can see what they actually are before deciding
// whether they need to be part of the backfill too.
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");
  const ownerUid = process.argv[2] || "8JHmWXe9GldYdtjgvX4KBcWh1423";

  const snap = await adminDb
    .collection("messages")
    .where("ownerUid", "==", ownerUid)
    .limit(500)
    .get();

  let shown = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const sid = String(data.sid || data.twilioSid || "").trim();
    const conversationId = String(data.conversationId || "").trim();
    if (sid && conversationId) continue;

    console.log(`\ndoc: ${d.id}`);
    console.log(JSON.stringify(data, null, 2));
    shown++;
    if (shown >= 5) break;
  }

  console.log(`\nShown ${shown} example(s) with missing sid/conversationId out of first 500 scanned.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
