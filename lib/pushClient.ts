import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { doc, updateDoc, arrayUnion } from "firebase/firestore";
import { app, auth, db } from "./firebase";

// Client-side half of push notifications for the installed Replies PWA.
// Everything here is opt-in and best-effort: if the browser doesn't
// support push (desktop Safari, a plain un-installed tab, etc.), or the
// VAPID key isn't configured yet, every function below resolves to a safe
// "not available" result instead of throwing - nothing in the rest of the
// app depends on this working.

export type EnableNotificationsResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "missing-config" | "error" };

async function isPushSupported() {
  if (typeof window === "undefined") return false;
  try {
    return await isSupported();
  } catch {
    return false;
  }
}

export async function enableNotifications(): Promise<EnableNotificationsResult> {
  const supported = await isPushSupported();
  if (!supported || typeof Notification === "undefined") {
    return { ok: false, reason: "unsupported" };
  }

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    console.error(
      "NEXT_PUBLIC_FIREBASE_VAPID_KEY is not set - generate a Web Push " +
        "certificate in Firebase Console > Project Settings > Cloud " +
        "Messaging and add it before notifications can work."
    );
    return { ok: false, reason: "missing-config" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "denied" };
  }

  const user = auth.currentUser;
  if (!user) {
    return { ok: false, reason: "error" };
  }

  try {
    const registration = await navigator.serviceWorker.register(
      "/firebase-messaging-sw.js"
    );

    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    });

    if (!token) {
      return { ok: false, reason: "error" };
    }

    await updateDoc(doc(db, "users", user.uid), {
      fcmTokens: arrayUnion(token),
    });

    return { ok: true };
  } catch (error) {
    console.error("Failed to enable push notifications", error);
    return { ok: false, reason: "error" };
  }
}

// Shows a real system notification even while the app is open and in the
// foreground - by default FCM only auto-shows notifications for background
// tabs, and without this, "customer replied" pushes would silently do
// nothing whenever the rep already has Replies open (arguably the most
// common case). Best-effort: wrapped so a failure here never affects the
// live conversation list, which already updates itself independently.
export function listenForForegroundReplies(onNavigate?: (link: string) => void) {
  let unsubscribe: (() => void) | undefined;

  (async () => {
    const supported = await isPushSupported();
    if (!supported) return;

    try {
      const messaging = getMessaging(app);
      unsubscribe = onMessage(messaging, (payload) => {
        const title = payload.notification?.title || "New reply";
        const body = payload.notification?.body || "";
        const badgeCount = Number(payload.data?.badgeCount || 0);
        const link =
          (payload.fcmOptions as any)?.link ||
          payload.data?.link ||
          "/replies";

        if ("setAppBadge" in navigator) {
          if (badgeCount > 0) {
            (navigator as any).setAppBadge(badgeCount).catch(() => {});
          } else {
            (navigator as any).clearAppBadge?.().catch(() => {});
          }
        }

        if (Notification.permission === "granted") {
          const notif = new Notification(title, {
            body,
            icon: "/icons/icon-192.png",
          });
          notif.onclick = () => {
            window.focus();
            onNavigate?.(link);
          };
        }
      });
    } catch (error) {
      console.error("Foreground push listener failed to start", error);
    }
  })();

  return () => {
    unsubscribe?.();
  };
}

// Keeps the app-icon badge in sync with the same "Customer Replied" number
// shown in-app, any time it changes while the app is open (not just on
// push). No-op wherever the Badging API isn't supported.
export function syncAppBadge(count: number) {
  if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
  try {
    if (count > 0) {
      (navigator as any).setAppBadge(count).catch(() => {});
    } else {
      (navigator as any).clearAppBadge?.().catch(() => {});
    }
  } catch {
    // Badging API not available in this browser - safe to ignore.
  }
}
