// Sends a one-off push notification/announcement to EVERY user across the
// whole platform who has already enabled notifications (i.e. has at least
// one saved FCM token on their `users` doc) - not just one owner's account.
// This is the broadcast counterpart to notifyOwnerOfReply() in
// lib/pushNotify.ts, which only ever pushes to a single conversation's
// owner. Deliberately a standalone script (like every other admin tool in
// this folder) rather than an in-app button: there's no admin-role
// authorization system in the app itself yet, so a button any signed-in
// user could reach would let any tenant spam every other tenant. Running
// this from your own machine, with your own Firebase Admin credentials, is
// the safe way to do this today.
//
// Usage:
//   npx tsx tools/send-broadcast-notification.ts "<title>" "<body>" [linkPath]
// Example:
//   npx tsx tools/send-broadcast-notification.ts "New feature" "Pinned conversations now show up separately - check it out." /replies
//
// linkPath is optional and defaults to "/replies" (where tapping the
// notification will take the user, same as a real customer-reply push).
//
// Safe to re-run: dead/uninstalled tokens found along the way are pruned
// from each user's doc exactly like the normal reply-notification path
// does, so running this periodically also keeps everyone's token lists
// clean.

import * as dotenv from "dotenv";
import { FieldValue } from "firebase-admin/firestore";
dotenv.config({ path: ".env.local" });

function truncate(value: string, max = 140) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function main() {
  const title = process.argv[2];
  const body = process.argv[3];
  const linkPath = process.argv[4] || "/replies";

  if (!title || !body) {
    console.error(
      'Usage: npx tsx tools/send-broadcast-notification.ts "<title>" "<body>" [linkPath]'
    );
    process.exit(1);
  }

  const { adminDb, adminMessaging } = await import("../lib/firebaseAdmin");

  console.log(`Broadcasting:\n  Title: ${title}\n  Body: ${truncate(body)}\n  Link: ${linkPath}\n`);

  const usersSnap = await adminDb.collection("users").get();

  // token -> which user doc it belongs to, so a failed/dead token can be
  // pruned from the right doc afterward.
  const tokenOwners: Map<string, string> = new Map();
  const allTokens: string[] = [];

  usersSnap.docs.forEach((doc) => {
    const data = doc.data();
    const tokens: string[] = Array.isArray(data.fcmTokens)
      ? data.fcmTokens.filter((t: unknown) => typeof t === "string" && t)
      : [];
    tokens.forEach((t) => {
      tokenOwners.set(t, doc.id);
      allTokens.push(t);
    });
  });

  console.log(
    `Found ${allTokens.length} device token(s) across ${usersSnap.size} user account(s).\n`
  );

  if (allTokens.length === 0) {
    console.log("Nobody has notifications enabled yet - nothing to send.");
    return;
  }

  // FCM caps sendEachForMulticast at 500 tokens per call.
  const BATCH_SIZE = 500;
  const deadTokens: string[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < allTokens.length; i += BATCH_SIZE) {
    const batch = allTokens.slice(i, i + BATCH_SIZE);

    const response = await adminMessaging.sendEachForMulticast({
      tokens: batch,
      webpush: {
        fcmOptions: { link: linkPath },
        headers: { Urgency: "high" },
      },
      // Data-only, same convention as every other push this app sends -
      // the service worker / foreground listener read title+body from
      // `data`, not from a top-level `notification` field. That's what
      // stops the double-banner/double-sound bug from ever coming back.
      data: { title, body },
    });

    response.responses.forEach((r, idx) => {
      if (r.success) {
        successCount++;
      } else {
        failureCount++;
        if (
          r.error?.code === "messaging/registration-token-not-registered" ||
          r.error?.code === "messaging/invalid-registration-token"
        ) {
          deadTokens.push(batch[idx]);
        }
      }
    });

    console.log(
      `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${response.successCount} sent, ${response.failureCount} failed.`
    );
  }

  console.log(`\nDone. ${successCount} delivered, ${failureCount} failed (of ${allTokens.length} total).`);

  if (deadTokens.length > 0) {
    console.log(`Pruning ${deadTokens.length} dead/uninstalled token(s)...`);
    const byOwner: Map<string, string[]> = new Map();
    deadTokens.forEach((t) => {
      const uid = tokenOwners.get(t);
      if (!uid) return;
      const list = byOwner.get(uid) || [];
      list.push(t);
      byOwner.set(uid, list);
    });

    for (const [uid, tokens] of byOwner.entries()) {
      await adminDb
        .collection("users")
        .doc(uid)
        .update({ fcmTokens: FieldValue.arrayRemove(...tokens) })
        .catch(() => {});
    }
    console.log("Done pruning.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
