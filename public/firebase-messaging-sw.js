// Background push handler for the installed Replies PWA. This file must
// live at this exact path (/firebase-messaging-sw.js) - Firebase's client
// SDK auto-registers it under that name when getToken() is called with no
// custom registration passed in.
//
// These config values are the same public web config already embedded in
// lib/firebase.ts - not secret, safe to duplicate here (a service worker
// can't import from the app bundle, so it needs its own copy).
importScripts("https://www.gstatic.com/firebasejs/12.11.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.11.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDI21aIwohPiLAr6p4OwKYgSOcg-3alPc4",
  authDomain: "nexgen-sms.firebaseapp.com",
  projectId: "nexgen-sms",
  storageBucket: "nexgen-sms.firebasestorage.app",
  messagingSenderId: "824952400922",
  appId: "1:824952400922:web:83c2bc6630b993779c75a3",
});

const messaging = firebase.messaging();

// Fires when a push arrives while the app is closed or backgrounded - the
// actual "WhatsApp-like" alert (sound + banner) comes from the OS itself
// once we call showNotification below; nothing here plays a sound directly.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "New reply";
  const body = payload.notification?.body || "";
  const badgeCount = Number(payload.data?.badgeCount || 0);
  const link = payload.fcmOptions?.link || payload.data?.link || "/login?next=/replies";

  // Updates the red number on the home-screen icon, same as WhatsApp's
  // unread count. Supported on iOS 16.4+ / Android Chrome for installed
  // (Add to Home Screen) web apps - silently a no-op everywhere else.
  if ("setAppBadge" in self.navigator) {
    if (badgeCount > 0) {
      self.navigator.setAppBadge(badgeCount).catch(() => {});
    } else {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }

  self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { link },
    tag: payload.data?.conversationId || undefined,
  });
});

// Tapping the notification opens (or focuses) the Replies app instead of
// leaving it sitting in the notification tray with nothing happening.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || "/login?next=/replies";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsList) => {
        for (const client of clientsList) {
          if ("focus" in client) {
            client.navigate(link);
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(link);
        }
      })
  );
});
