import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

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