import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminMessaging } from "./firebaseAdmin";

// Push notifications for new customer replies (the "WhatsApp-like" alert +
// app icon badge on the installed Replies PWA). This file is intentionally
// self-contained and fails silently on every internal error - it is called
// as a best-effort side effect from the inbound Twilio webhook, AFTER the
// real message/conversation data has already been saved, and must never be
// able to affect whether an inbound message is stored correctly. If FCM is
// unreachable, misconfigured, or a token is stale, the customer's message
// still saves exactly as it always has - only the notification is skipped.

function truncate(value: string, max = 90) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// Mirrors the exact "Customer Replied" definition already used by the nav
// badge (components/useRepliedCount.ts) - has an unanswered inbound reply,
// not blocked - so the OS badge number always matches what the app itself
// shows elsewhere. Pin status doesn't exclude a conversation from this
// count: pinning is a quick-access shortcut, not a way to make a genuine
// unread reply stop counting. Server-side count() aggregation, so this is
// one cheap query regardless of how many conversations the account has.
async function getUnreadBadgeCount(ownerUid: string): Promise<number> {
  const col = adminDb.collection("conversations");

  const snap = await col
    .where("ownerUid", "==", ownerUid)
    .where("blocked", "==", false)
    .where("hasReply", "==", true)
    .where("lastDirection", "==", "inbound")
    .count()
    .get();

  return snap.data().count;
}

export async function notifyOwnerOfReply(opts: {
  ownerUid: string;
  conversationId: string;
  fromPhone: string;
  customerName?: string;
  previewText: string;
}): Promise<void> {
  try {
    const userSnap = await adminDb.collection("users").doc(opts.ownerUid).get();
    if (!userSnap.exists) return;

    const tokens: string[] = Array.isArray(userSnap.data()?.fcmTokens)
      ? userSnap.data()!.fcmTokens.filter((t: unknown) => typeof t === "string" && t)
      : [];

    if (tokens.length === 0) return;

    const badgeCount = await getUnreadBadgeCount(opts.ownerUid);

    const title = opts.customerName || opts.fromPhone || "New reply";
    const body = truncate(opts.previewText || "Sent a message");

    // Deliberately data-only - no top-level `notification` and no
    // `webpush.notification` field. Either of those makes the browser's own
    // push layer auto-display a system notification on top of the manual
    // showNotification()/new Notification() calls already made by the
    // service worker (background) and listenForForegroundReplies
    // (foreground) below - resulting in two banners and two sounds for one
    // customer reply. Sending data-only means those two handlers are the
    // only thing that ever displays anything, so it fires exactly once.
    const response = await adminMessaging.sendEachForMulticast({
      tokens,
      webpush: {
        fcmOptions: {
          link: `/login?next=${encodeURIComponent(`/replies/${opts.fromPhone}`)}`,
        },
        headers: {
          Urgency: "high",
        },
      },
      data: {
        title,
        body,
        badgeCount: String(badgeCount),
        conversationId: opts.conversationId,
        phone: opts.fromPhone,
      },
    });

    // Stale/uninstalled tokens come back as specific error codes - prune
    // them so future sends don't keep wasting a call on a dead device.
    const deadTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (
        !r.success &&
        (r.error?.code === "messaging/registration-token-not-registered" ||
          r.error?.code === "messaging/invalid-registration-token")
      ) {
        deadTokens.push(tokens[i]);
      }
    });

    if (deadTokens.length > 0) {
      await adminDb
        .collection("users")
        .doc(opts.ownerUid)
        .update({ fcmTokens: FieldValue.arrayRemove(...deadTokens) })
        .catch(() => {});
    }
  } catch (error) {
    console.error("notifyOwnerOfReply: push notification failed (non-fatal)", error);
  }
}
