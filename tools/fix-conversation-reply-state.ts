import * as admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

const TARGET_EMAIL = "sunnyadminsms@nexgen.io";
const TARGET_TWILIO_NUMBER = "+19145674441";
const BATCH_SIZE = 25;

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function conversationIdFor(uid: string, phone: string) {
  return `${uid}_${phoneDocId(phone)}`;
}

type ReplyRecord = {
  id: string;
  sid: string;
  twilioSid: string;
  ownerUid: string;
  ownerEmail: string;
  ownerName: string;
  ownerRole: string;
  phone: string;
  from: string;
  to: string;
  body: string;
  status: string;
  direction: string;
  read: boolean;
  twilioNumber: string;
  assignedTwilioNumber: string;
  messagingServiceSid: string;
  createdAt: FirebaseFirestore.Timestamp | null;
  updatedAt: FirebaseFirestore.Timestamp | null;
  keyword: string;
  blockedAfterMessage: boolean;
  name: string;
};

async function getTargetUser() {
  const snap = await db
    .collection("users")
    .where("email", "==", TARGET_EMAIL)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new Error(`User not found for email ${TARGET_EMAIL}`);
  }

  const doc = snap.docs[0];
  const data = doc.data() || {};

  return {
    uid: doc.id,
    email: String(data.email || TARGET_EMAIL),
    name: String(data.name || ""),
    role: String(data.role || "user"),
    twilioNumber: toE164(
      String(data.twilioNumber || data.assignedTwilioNumber || TARGET_TWILIO_NUMBER)
    ),
  };
}

async function loadRepliesForTarget(uid: string): Promise<ReplyRecord[]> {
  const normalizedTwilio = toE164(TARGET_TWILIO_NUMBER);

  const [byOwnerUid, byOwnerEmail, byTwilioNumber, byAssignedTwilio] =
    await Promise.all([
      db.collection("replies").where("ownerUid", "==", uid).get(),
      db.collection("replies").where("ownerEmail", "==", TARGET_EMAIL).get(),
      db.collection("replies").where("twilioNumber", "==", normalizedTwilio).get(),
      db.collection("replies").where("assignedTwilioNumber", "==", normalizedTwilio).get(),
    ]);

  const map = new Map<string, ReplyRecord>();

  for (const snap of [byOwnerUid, byOwnerEmail, byTwilioNumber, byAssignedTwilio]) {
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const sid = String(d.sid || d.twilioSid || doc.id || "").trim();
      const phone = toE164(String(d.phone || d.from || ""));
      const direction = String(d.direction || "").toLowerCase();

      if (!sid || !phone) continue;
      if (direction && direction !== "inbound") continue;

      map.set(doc.id, {
        id: doc.id,
        sid,
        twilioSid: String(d.twilioSid || sid),
        ownerUid: String(d.ownerUid || uid),
        ownerEmail: String(d.ownerEmail || TARGET_EMAIL),
        ownerName: String(d.ownerName || ""),
        ownerRole: String(d.ownerRole || "user"),
        phone,
        from: toE164(String(d.from || phone)),
        to: toE164(String(d.to || d.twilioNumber || normalizedTwilio)),
        body: String(d.body || ""),
        status: String(d.status || "received"),
        direction: "inbound",
        read: d.read === true,
        twilioNumber: toE164(String(d.twilioNumber || normalizedTwilio)),
        assignedTwilioNumber: toE164(
          String(d.assignedTwilioNumber || d.twilioNumber || normalizedTwilio)
        ),
        messagingServiceSid: String(d.messagingServiceSid || ""),
        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null,
        keyword: String(d.keyword || ""),
        blockedAfterMessage: d.blockedAfterMessage === true,
        name: String(d.name || ""),
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const aMs = a.createdAt?.toMillis?.() || 0;
    const bMs = b.createdAt?.toMillis?.() || 0;
    return aMs - bMs;
  });
}

async function ensureThreadMessage(
  uid: string,
  reply: ReplyRecord,
  fallbackUser: { email: string; name: string; role: string }
) {
  const conversationId = conversationIdFor(uid, reply.phone);
  const convoRef = db.collection("conversations").doc(conversationId);
  const threadRef = convoRef.collection("messages").doc(reply.sid);

  const [convoSnap, threadSnap] = await Promise.all([convoRef.get(), threadRef.get()]);
  const convo = convoSnap.exists ? convoSnap.data() || {} : {};

  const createdAt = reply.createdAt || admin.firestore.FieldValue.serverTimestamp();
  const updatedAt = reply.updatedAt || admin.firestore.FieldValue.serverTimestamp();

  if (!threadSnap.exists) {
    await threadRef.set(
      {
        sid: reply.sid,
        twilioSid: reply.twilioSid || reply.sid,
        ownerUid: uid,
        ownerEmail: reply.ownerEmail || fallbackUser.email,
        ownerName: reply.ownerName || fallbackUser.name,
        ownerRole: reply.ownerRole || fallbackUser.role,
        conversationId,
        from: reply.from || reply.phone,
        to: reply.to || TARGET_TWILIO_NUMBER,
        phone: reply.phone,
        body: reply.body,
        direction: "inbound",
        status: reply.status || "received",
        read: reply.read === true,
        twilioNumber: reply.twilioNumber || TARGET_TWILIO_NUMBER,
        assignedTwilioNumber:
          reply.assignedTwilioNumber || reply.twilioNumber || TARGET_TWILIO_NUMBER,
        messagingServiceSid: reply.messagingServiceSid || "",
        keyword: reply.keyword || "",
        blockedAfterMessage: reply.blockedAfterMessage === true,
        createdAt,
        updatedAt,
      },
      { merge: true }
    );
  }

  const existingName =
    String(convo.name || "").trim() ||
    String(reply.name || "").trim() ||
    "";

  const convoUpdate: Record<string, any> = {
    ownerUid: uid,
    ownerEmail: reply.ownerEmail || fallbackUser.email,
    ownerName: reply.ownerName || fallbackUser.name,
    ownerRole: reply.ownerRole || fallbackUser.role,
    phone: reply.phone,
    name: existingName,
    twilioNumber: reply.twilioNumber || TARGET_TWILIO_NUMBER,
    assignedTwilioNumber:
      reply.assignedTwilioNumber || reply.twilioNumber || TARGET_TWILIO_NUMBER,
    hasReply: true,
    status: "replied",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastInboundSid: reply.sid,
    blocked: reply.blockedAfterMessage === true,
  };

  if (reply.messagingServiceSid) {
    convoUpdate.messagingServiceSid = reply.messagingServiceSid;
  }

  await convoRef.set(convoUpdate, { merge: true });

  return conversationId;
}

async function recomputeConversation(conversationId: string) {
  const convoRef = db.collection("conversations").doc(conversationId);
  const msgsSnap = await convoRef.collection("messages").get();

  const rows = msgsSnap.docs
    .map((doc) => {
      const d = doc.data() || {};
      const createdAt = d.createdAt || null;
      return {
        body: String(d.body || ""),
        direction: String(d.direction || ""),
        read: d.read === true,
        phone: String(d.phone || ""),
        twilioNumber: String(d.twilioNumber || d.assignedTwilioNumber || ""),
        assignedTwilioNumber: String(d.assignedTwilioNumber || d.twilioNumber || ""),
        messagingServiceSid: String(d.messagingServiceSid || ""),
        createdAt,
        createdAtMs: typeof createdAt?.toMillis === "function" ? createdAt.toMillis() : 0,
      };
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  if (rows.length === 0) return;

  const inbound = rows.filter((r) => r.direction === "inbound");
  const outbound = rows.filter((r) => r.direction === "outbound");
  const unreadInbound = inbound.filter((r) => !r.read).length;
  const last = rows[rows.length - 1];
  const lastInbound = inbound[inbound.length - 1];
  const lastOutbound = outbound[outbound.length - 1];

  const updateData: Record<string, any> = {
    lastMessage: last.body || "",
    lastDirection: last.direction || "",
    lastMessageAt: last.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    hasReply: inbound.length > 0,
    status: inbound.length > 0 ? "replied" : "awaiting_reply",
    unreadCount: unreadInbound,
    replyCount: inbound.length,
    inboundCount: inbound.length,
    outboundCount: outbound.length,
    messageCount: rows.length,
    lastInboundAt: lastInbound?.createdAt || null,
    lastOutboundAt: lastOutbound?.createdAt || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (last.phone) updateData.phone = last.phone;
  if (last.twilioNumber) updateData.twilioNumber = last.twilioNumber;
  if (last.assignedTwilioNumber) updateData.assignedTwilioNumber = last.assignedTwilioNumber;
  if (last.messagingServiceSid) updateData.messagingServiceSid = last.messagingServiceSid;

  await convoRef.set(updateData, { merge: true });
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  console.log("Starting restore...");

  const targetUser = await getTargetUser();
  console.log("Target user:", targetUser);

  const replies = await loadRepliesForTarget(targetUser.uid);
  console.log(`Found ${replies.length} inbound reply docs to inspect`);

  const touchedConversationIds = new Set<string>();
  let restoredThreadMessages = 0;

  for (const reply of replies) {
    const conversationId = conversationIdFor(targetUser.uid, reply.phone);
    const threadRef = db.collection("conversations").doc(conversationId).collection("messages").doc(reply.sid);
    const threadSnap = await threadRef.get();

    if (!threadSnap.exists) {
      restoredThreadMessages += 1;
    }

    const touchedId = await ensureThreadMessage(targetUser.uid, reply, {
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role,
    });

    touchedConversationIds.add(touchedId);
  }

  const conversationIds = Array.from(touchedConversationIds);
  console.log(
    `Restored or verified ${replies.length} reply rows. Newly inserted thread messages: ${restoredThreadMessages}`
  );
  console.log(`Recomputing ${conversationIds.length} conversations in batches of ${BATCH_SIZE}...`);

  const chunks = chunkArray(conversationIds, BATCH_SIZE);

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    console.log(`Processing batch ${i + 1} of ${chunks.length}...`);

    for (const conversationId of batch) {
      await recomputeConversation(conversationId);
      console.log(`Recomputed conversation ${conversationId}`);
    }
  }

  console.log("Restore completed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Restore failed:", err);
    process.exit(1);
  });