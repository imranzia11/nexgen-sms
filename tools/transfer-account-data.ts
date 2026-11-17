// Re-attaches data left behind by a deleted account to its replacement.
//
// Deleting a user in Firebase removes the login and users/{uid} profile but
// NOT the data (uploads, leads, conversations, messages, follow-ups ...),
// which stays tagged with the OLD uid. A re-created account gets a NEW uid,
// so it sees nothing. This script moves everything from the old uid to the
// new one.
//
// Step 1 - find the orphaned data (read-only):
//   npx tsx tools/transfer-account-data.ts --find
//
// Step 2 - preview the move (read-only):
//   npx tsx tools/transfer-account-data.ts --from-uid=OLD_UID --to-email=jon@nexgenmerchant.io
//
// Step 3 - do it:
//   npx tsx tools/transfer-account-data.ts --from-uid=OLD_UID --to-email=jon@nexgenmerchant.io --apply
//
// What changes: ownerUid -> new uid on every doc; document IDs and
// conversationId fields that start with "<oldUid>_" are rewritten to
// "<newUid>_" (conversations are copied to their new ID with all messages,
// then the old copies are deleted). Billing fields on users/{uid} (rate,
// credit) are NOT carried - set them again with the admin tools.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const ROOT_COLLECTIONS = [
  "uploads",
  "leads",
  "campaigns",
  "messageTemplates",
  "followUps",
  "messages",
  "replies",
  "blacklisted_numbers",
  "blacklist_events",
  "calls",
  "deletionLogs",
  "followUpScheduleErrors",
];

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const { adminDb } = await import("../lib/firebaseAdmin");

  const { getAuth } = await import("firebase-admin/auth");
  const usersSnap = await adminDb.collection("users").get();

  // An account counts as "gone" if its users/{uid} profile is missing OR its
  // login no longer exists in Firebase Authentication (deleting only the
  // login leaves the profile behind, which hides the old data from a scan).
  const profileUids = usersSnap.docs.map((d) => d.id);
  const authExists = new Set<string>();
  for (let i = 0; i < profileUids.length; i += 100) {
    const res = await getAuth().getUsers(profileUids.slice(i, i + 100).map((uid) => ({ uid })));
    res.users.forEach((u) => authExists.add(u.uid));
  }
  const knownUids = new Set(profileUids.filter((uid) => authExists.has(uid)));
  const staleProfiles = usersSnap.docs.filter((d) => !authExists.has(d.id));
  if (staleProfiles.length > 0) {
    console.log("Profiles whose login was deleted (data may still be under these):");
    staleProfiles.forEach((d) => {
      const x = d.data() || {};
      console.log(`  ${d.id}  ${x.email || ""}  ${x.twilioNumber || ""}`);
    });
    console.log("");
  }

  // ---------- --find ----------
  if (process.argv.includes("--find")) {
    console.log("Scanning for data owned by accounts that no longer exist...\n");
    const orphans = new Map<string, Record<string, number>>();
    const sample = new Map<string, string>();

    for (const col of [
      "uploads",
      "leads",
      "conversations",
      "campaigns",
      "followUps",
      "messages",
      "replies",
    ]) {
      const snap = await adminDb.collection(col).select("ownerUid", "fileName", "twilioNumber").get();
      for (const d of snap.docs) {
        const owner = String(d.get("ownerUid") || "");
        if (!owner || knownUids.has(owner)) continue;
        const counts = orphans.get(owner) || {};
        counts[col] = (counts[col] || 0) + 1;
        orphans.set(owner, counts);
        if (!sample.has(owner)) {
          sample.set(owner, String(d.get("fileName") || d.get("twilioNumber") || ""));
        }
      }
    }

    if (orphans.size === 0) {
      console.log("No orphaned data found - every owner uid still has an account.");
      return;
    }
    for (const [uid, counts] of orphans) {
      console.log(`OLD UID: ${uid}`);
      console.log(`  ${JSON.stringify(counts)}`);
      if (sample.get(uid)) console.log(`  sample: ${sample.get(uid)}`);
    }
    console.log("\nPick the uid that is Jon's (largest counts / his file names), then run step 2.");
    return;
  }

  // ---------- transfer ----------
  const fromUid = getArg("from-uid").trim();
  const toEmail = getArg("to-email").trim().toLowerCase();
  const apply = process.argv.includes("--apply");

  if (!fromUid || !toEmail) {
    console.error("Usage: --find   OR   --from-uid=OLD_UID --to-email=user@x.com [--apply]");
    process.exit(1);
  }

  const toSnap = await adminDb.collection("users").where("email", "==", toEmail).limit(1).get();
  if (toSnap.empty) {
    console.error(`No account with email ${toEmail}.`);
    process.exit(1);
  }
  const toUid = toSnap.docs[0].id;
  if (toUid === fromUid) {
    console.error("Old and new uid are the same.");
    process.exit(1);
  }
  if (knownUids.has(fromUid)) {
    console.error(`${fromUid} still belongs to an existing account - refusing to move it.`);
    process.exit(1);
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Moving data from ${fromUid} -> ${toUid} (${toEmail})\n`);

  const rewriteId = (id: string) =>
    id.startsWith(`${fromUid}_`) ? `${toUid}_${id.slice(fromUid.length + 1)}` : id;

  const fixFields = (data: Record<string, any>) => {
    const out: Record<string, any> = { ...data, ownerUid: toUid };
    if (typeof out.conversationId === "string") out.conversationId = rewriteId(out.conversationId);
    if (out.uploadedBy === fromUid) out.uploadedBy = toUid;
    return out;
  };

  // Root collections
  for (const col of ROOT_COLLECTIONS) {
    const snap = await adminDb.collection(col).where("ownerUid", "==", fromUid).get();
    console.log(`${col}: ${snap.size} doc(s)`);
    if (!apply || snap.empty) continue;

    let batch = adminDb.batch();
    let ops = 0;
    for (const d of snap.docs) {
      const newId = rewriteId(d.id);
      if (newId === d.id) {
        batch.update(d.ref, {
          ownerUid: toUid,
          ...(typeof d.get("conversationId") === "string"
            ? { conversationId: rewriteId(d.get("conversationId")) }
            : {}),
          ...(d.get("uploadedBy") === fromUid ? { uploadedBy: toUid } : {}),
        });
        ops += 1;
      } else {
        batch.set(adminDb.collection(col).doc(newId), fixFields(d.data()));
        batch.delete(d.ref);
        ops += 2;
      }
      if (ops >= 400) {
        await batch.commit();
        batch = adminDb.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  }

  // Conversations (+ messages subcollection): the doc ID contains the uid, so
  // each is copied to its new ID and the old one removed.
  const convos = await adminDb.collection("conversations").where("ownerUid", "==", fromUid).get();
  console.log(`conversations: ${convos.size} doc(s) (+ their messages)`);
  if (apply) {
    let done = 0;
    for (const c of convos.docs) {
      const newRef = adminDb.collection("conversations").doc(rewriteId(c.id));
      await newRef.set(fixFields(c.data()));

      const msgs = await c.ref.collection("messages").get();
      for (let i = 0; i < msgs.docs.length; i += 400) {
        const batch = adminDb.batch();
        msgs.docs.slice(i, i + 400).forEach((m) => {
          batch.set(newRef.collection("messages").doc(m.id), fixFields(m.data()));
          batch.delete(m.ref);
        });
        await batch.commit();
      }
      await c.ref.delete();
      done += 1;
      if (done % 200 === 0) console.log(`  ...${done}/${convos.size} conversations moved`);
    }
  }

  console.log(apply ? "\nDone." : "\nDRY RUN - nothing written. Re-run with --apply.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
