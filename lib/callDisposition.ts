"use client";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { phoneDocId, reversePhone, toE164 } from "./phone";

// What a rep can do with a number during or right after a call:
//  - markInterested: flags the lead as an interested customer and opens a
//    conversation for it that shows in Replies under "★ Call Leads" until the
//    first text is sent (the send-reply API then clears the callLead flag)
//  - blockNumber: adds the number to the account's blocked list (same record
//    the Replies page "Block" action writes), so it is never texted or dialed

export type DispositionEvent = {
  phone: string;
  interested?: boolean;
  blocked?: boolean;
  badNumber?: boolean;
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

// Existence check by query. A direct getDoc() on a conversation that doesn't
// exist is rejected by the security rules (they read resource.data.ownerUid,
// which is null for a missing document), so we look it up with a query that
// is scoped to the owner instead.
async function findConversation(uid: string, phone: string) {
  const snap = await getDocs(
    query(
      collection(db, "conversations"),
      where("ownerUid", "==", uid),
      where("phone", "==", phone),
      limit(1)
    )
  );
  return snap.docs[0] || null;
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

  // Open the conversation so the lead shows in Replies under "Call Leads".
  // A conversation that already has messages is left alone - it is already
  // in Replies.
  const convoRef = doc(db, "conversations", `${uid}_${phoneDocId(phone)}`);
  const existingConvo = await findConversation(uid, phone);
  if (!existingConvo) {
    const number = toE164(String(data.twilioNumber || data.assignedTwilioNumber || ""));
    const leadName = String(leadDocs.find((d) => d.get("name"))?.get("name") || "");
    await setDoc(convoRef, {
      ownerUid: uid,
      ownerEmail: String(data.email || ""),
      ownerName: String(data.name || ""),
      ownerRole: String(data.role || "user"),
      phone,
      phoneReversed: reversePhone(phone),
      name: leadName,
      twilioNumber: number,
      assignedTwilioNumber: number,
      lastMessage: "Interested customer (from call)",
      lastDirection: "outbound",
      lastMessageAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      status: "call_lead",
      hasReply: false,
      unreadCount: 0,
      replyCount: 0,
      outboundCount: 0,
      messageCount: 0,
      blocked: false,
      callLead: true,
    });
  }

  announce({ phone, interested: true });
}

// Wrong or disconnected number. Separate from blocking: nothing is added to
// the blocked list. The lead is flagged badNumber and its status becomes
// "invalid", so the dialer and bulk texting both skip it from now on, and it
// is listed under the "Wrong / Disconnected" filter.
export async function markBadNumber(rawPhone: string) {
  const phone = toE164(rawPhone);
  const { uid } = await currentProfile();
  const note = "Wrong or disconnected number (from call)";

  const leadDocs = await leadsForPhone(uid, phone);
  if (leadDocs.length > 0) {
    await Promise.all(
      leadDocs.map((d) =>
        updateDoc(d.ref, {
          badNumber: true,
          badNumberAt: serverTimestamp(),
          interested: false,
          status: "invalid",
          validationNote: note,
        })
      )
    );
  } else {
    await addDoc(collection(db, "leads"), {
      uploadId: "",
      uploadedBy: uid,
      ownerUid: uid,
      name: "",
      phone,
      rawPhone: phone,
      status: "invalid",
      validationNote: note,
      sourceFileName: "Calls",
      badNumber: true,
      badNumberAt: serverTimestamp(),
      interested: false,
      createdAt: serverTimestamp(),
    });
  }

  announce({ phone, badNumber: true, interested: false });
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
  const existingConvo = await findConversation(uid, phone);
  if (existingConvo) {
    await updateDoc(existingConvo.ref, {
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
