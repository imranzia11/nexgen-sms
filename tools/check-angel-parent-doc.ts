// READ-ONLY. Checks whether Angel's conversation summary doc still exists,
// to determine whether the "Missing or insufficient permissions" error on
// thread pages is confined to conversations with a missing parent doc, or
// happens even on ones that are intact.
//
// Usage:
//   npx tsx tools/check-angel-parent-doc.ts

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");
  const id = "SKmaVTN8TjeTayQ9FiuStmNiNLE2_+13058075743";
  const snap = await adminDb.collection("conversations").doc(id).get();
  console.log(`conversations/${id} exists:`, snap.exists);
  if (snap.exists) {
    console.log(JSON.stringify(snap.data(), null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
