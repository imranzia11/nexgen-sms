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
// badge (components/useRepliedCount.ts) - not pinned, has an unanswered
// inbound reply, not blocked - so the OS badge number always matches what
// the app itself shows elsewhere. Server-side count() aggregation, so this
// is one cheap query regardless of how many conversations the account has.
async function getUnreadBadgeCount(ownerUid: string): Promise<number> {
  const col = adminDb.collection("conversations");
  const base = [
    ["ownerUid", "==", ownerUid],
    ["blocked", "==", false],
  ] as const;

  const countQuery = async (...extra: [string, FirebaseFirestore.WhereFilterOp, unknown][]) => {
    let q: FirebaseFirestore.Query = col;
    for (const [field, op, value] of [...base, ...extra]) {
      q = q.where(field, op, value);
    }
    const snap = await q.count().get();
    return snap.data().count;
  };

  const [raw, pinnedOverlap] = await Promise.all([
    countQuery(["hasReply", "==", true], ["lastDirection", "==", "inbound"]),
    countQuery(
      ["pinned", "==", true],
      ["hasReply", "==", true],
      ["lastDirection", "==", "inbound"]
    ),
  ]);

  return Math.max(0, raw - pinnedOverlap);
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

    const response = await adminMessaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: {
        notification: {
          title,
          body,
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
        },
        fcmOptions: {
          link: `/login?next=${encodeURIComponent(`/replies/${opts.fromPhone}`)}`,
        },
        headers: {
          Urgency: "high",
        },
      },
      data: {
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
