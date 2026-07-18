// READ-ONLY. Dumps a user's saved messageTemplates docs, specifically the
// followUpMessage field on each slot - since loading a template on the
// dashboard auto-enables the follow-up checkbox IF and only IF that
// template's followUpMessage is non-empty (see loadTemplate() in
// app/dashboard/page.tsx). This tells us whether the client's templates
// could ever silently turn follow-up on/off when loaded.
//
// Usage:
//   npx tsx tools/check-user-templates.ts <ownerUid>

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const ownerUid = process.argv[2];
  if (!ownerUid) {
    console.error("Usage: npx tsx tools/check-user-templates.ts <ownerUid>");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");

  const snap = await adminDb
    .collection("messageTemplates")
    .where("ownerUid", "==", ownerUid)
    .get();

  if (snap.empty) {
    console.log("No saved templates found for this user - they've never saved a template slot.");
    return;
  }

  const docs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as any))
    .sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0));

  console.log(`Found ${docs.length} saved template slot(s):\n`);

  for (const t of docs) {
    const followUp = String(t.followUpMessage || "");
    console.log(`--- Slot ${t.slot}: "${t.name}" ---`);
    console.log(`  smsMessage:      ${String(t.smsMessage || "").slice(0, 60)}`);
    console.log(`  followUpMessage: ${followUp ? followUp.slice(0, 60) : "(EMPTY)"}`);
    console.log(
      `  => loading this template would set followUpEnabled to: ${followUp.trim() ? "TRUE (auto-enabled)" : "false (stays off)"}`
    );
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
