import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { initializeFirestore, getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDI21aIwohPiLAr6p4OwKYgSOcg-3alPc4",
  authDomain: "nexgen-sms.firebaseapp.com",
  projectId: "nexgen-sms",
  storageBucket: "nexgen-sms.firebasestorage.app",
  messagingSenderId: "824952400922",
  appId: "1:824952400922:web:83c2bc6630b993779c75a3",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export { app };
export const auth = getAuth(app);
// Root cause of the "Customer Replied tab randomly empty" report: the
// browser console showed `WebChannelConnection RPC 'Listen' stream ...
// transport errored` right after a `net::ERR_QUIC_PROTOCOL_ERROR` and a
// follow-up 400 on firestore.googleapis.com - a known Firestore JS SDK
// issue (see firebase/firebase-js-sdk#8889, #7354, #9243) where the
// browser's default QUIC/HTTP3 transport for the realtime Listen channel
// gets reset by a network/proxy/antivirus in between and the reconnect
// comes back malformed, silently dropping that one listener's data while
// other already-connected listeners (and one-shot count queries, which
// don't use this channel) keep working - exactly matching "Customer
// Replied" showing 0 while "Waiting for Customer" still showed 34.
// autoDetectLongPolling makes the SDK probe once at startup and fall back
// to plain long-polling if that probe looks unreliable, avoiding the QUIC
// path entirely for affected networks. Pure transport-layer change - no
// query, rule, or data logic touched.
let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
  });
} catch {
  // Firestore was already initialized against this app instance (e.g. dev
  // hot-reload re-running this module) - just reuse it instead of throwing.
  dbInstance = getFirestore(app);
}
export const db = dbInstance;
export const storage = getStorage(app);

// Explicit, not just relying on the SDK default (which is already
// browserLocalPersistence, but making it explicit means this behavior -
// stay signed in indefinitely, survive closing the tab/app entirely -
// can never silently change if Firebase's default ever does. This is what
// makes "sign in once, never asked again" work: the refresh token lives in
// localStorage and the SDK silently re-authenticates on every load instead
// of requiring a fresh login.
//
// Known limitation this can't fully fix: iOS Safari applies its own
// storage-eviction rules (Intelligent Tracking Prevention) to installed
// home-screen web apps, which can clear localStorage after ~7 days with no
// visits - a purely iOS/WebKit policy, not something any web app's code
// can override. Opening the app at least occasionally resets that clock.
if (typeof window !== "undefined") {
  void setPersistence(auth, browserLocalPersistence);
}