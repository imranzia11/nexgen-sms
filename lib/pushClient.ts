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

// Generates a short two-tone "ding" with the Web Audio API instead of
// shipping an audio file - no asset to host, no network request, and no
// autoplay-policy surprise from a <audio> element with a remote src.
// Browsers require at least one prior user gesture on the page before any
// audio can play at all (including this); on a desktop app someone is
// actively using, that's already satisfied by the time a reply comes in.
function playReplyChime() {
  try {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // Two quick notes (high then a touch higher) rather than one flat
    // tone - reads as a deliberate "new message" chime instead of a beep.
    [
      { freq: 880, start: 0, dur: 0.12 },
      { freq: 1108.73, start: 0.11, dur: 0.16 },
    ].forEach(({ freq, start, dur }) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.22, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + dur + 0.02);
    });

    // Tear down after the notes finish - nothing keeps this context alive
    // between replies, so a burst of several notifications doesn't pile up
    // AudioContexts.
    window.setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    // Web Audio unsupported/blocked - the visual notification still shows,
    // this is purely an enhancement on top of it.
  }
}

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
        // Reads from `data`, not `payload.notification` - see the comment
        // in lib/pushNotify.ts: the server sends a data-only message on
        // purpose so this handler is the only thing that ever displays a
        // notification in the foreground (a `notification` field would
        // make the browser auto-display one too, doubling the sound).
        const title = payload.data?.title || "New reply";
        const body = payload.data?.body || "";
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
          playReplyChime();

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
