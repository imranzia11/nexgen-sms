import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
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

export const auth = getAuth(app);
export const db = getFirestore(app);
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