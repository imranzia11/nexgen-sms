import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getMessaging } from "firebase-admin/messaging";

const hasServiceAccount =
  !!process.env.FIREBASE_PROJECT_ID &&
  !!process.env.FIREBASE_CLIENT_EMAIL &&
  !!process.env.FIREBASE_PRIVATE_KEY;

const storageBucket =
  process.env.FIREBASE_STORAGE_BUCKET ||
  (process.env.FIREBASE_PROJECT_ID
    ? `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`
    : undefined);

if (!getApps().length) {
  if (hasServiceAccount) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      }),
      storageBucket,
    });
  } else {
    initializeApp({
      credential: applicationDefault(),
      storageBucket,
    });
  }
}

export const adminDb = getFirestore();
export const adminStorage = getStorage();
export const adminMessaging = getMessaging();