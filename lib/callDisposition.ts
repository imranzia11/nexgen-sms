"use client";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { phoneDocId, toE164 } from "./phone";

// What a rep can do with a number during or right after a call:
//  - markInterested: flags the lead as an interested customer; it shows in
//    the dashboard's "Call Leads" tab until the first text is sent, which
//    opens the conversation in Replies
//  - blockNumber: adds the number to the account's blocked list (same record
//    the Replies page "Block" action writes), so it is never texted or dialed

export type DispositionEvent = {
  phone: string;
  interested?: boolean;
  blocked?: boolean;
};

function announce(detail: DispositionEvent) {
  window.dispatchEvent(new CustomEvent("lead-disposition", { detail }));
}

async function currentProfile() {
  const user = auth.currentUser;
  if (!user) throw new Error("You are not signed in.");
  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? snap.data() || {} : {};
  return { uid: user.uid, data };
}

async function leadsForPhone(uid: string, phone: string) {
  const snap = await getDocs(
    query(collection(db, "leads"), where("ownerUid", "==", uid), where("phone", "==", phone))
  );
  return snap.docs;
}

export async function markInterested(rawPhone: string) {
  const phone = toE164(rawPhone);
  const { uid, data } = await currentProfile();

  // The lead goes to the "Call Leads" list. It only reaches Replies once the
  // first text is sent (see components/CallLeadsPanel.tsx), so no conversation
  // is created here.
  const leadDocs = await leadsForPhone(uid, phone);
  if (leadDocs.length > 0) {
    await Promise.all(
      leadDocs.map((d) =>
        updateDoc(d.ref, {
          interested: true,
          interestedAt: serverTimestamp(),
          contacted: false,
        })
      )
    );
  } else {
    // A number dialed by hand that isn't in any imported file.
    await addDoc(collection(db, "leads"), {
      uploadId: "",
      uploadedBy: uid,
      ownerUid: uid,
      name: "",
      phone,
      rawPhone: phone,
      status: "verified",
      validationNote: "Added from a call",
      sourceFileName: "Calls",
      interested: true,
      interestedAt: serverTimestamp(),
      contacted: false,
      createdAt: serverTimestamp(),
    });
  }

  announce({ phone, interested: true });
}

export async function blockNumber(rawPhone: string) {
  const phone = toE164(rawPhone);
  const { uid, data } = await currentProfile();
  const number = String(data.twilioNumber || data.assignedTwilioNumber || "").trim();

  await setDoc(
    doc(db, "blacklisted_numbers", `${uid}_${phoneDocId(phone)}`),
    {
      ownerUid: uid,
      ownerEmail: String(data.email || ""),
      ownerName: String(data.name || ""),
      phone,
      twilioNumber: number,
      assignedTwilioNumber: String(data.assignedTwilioNumber || ""),
      status: "blocked",
      source: "manual_block_from_call",
      reason: "manual_block",
      lastKeyword: "STOP",
      lastBody: "",
      blockedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      unblockedAt: null,
    },
    { merge: true }
  );

  // Only touch a conversation that already exists.
  const convoRef = doc(db, "conversations", `${uid}_${phoneDocId(phone)}`);
  const convoSnap = await getDoc(convoRef);
  if (convoSnap.exists()) {
    await updateDoc(convoRef, {
      status: "blocked",
      blocked: true,
      updatedAt: serverTimestamp(),
    });
  }

  const leadDocs = await leadsForPhone(uid, phone);
  await Promise.all(
    leadDocs.map((d) => updateDoc(d.ref, { interested: false, blockedByCall: true }))
  );

  announce({ phone, blocked: true, interested: false });
}
