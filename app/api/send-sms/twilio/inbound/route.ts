import { NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

function xmlResponse() {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function normalizeKeyword(raw: string) {
  return String(raw || "").trim().toUpperCase();
}

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);

const START_KEYWORDS = new Set([
  "START",
  "UNSTOP",
  "YES",
]);

const HELP_KEYWORDS = new Set([
  "HELP",
  "INFO",
]);

export async function GET() {
  return new Response("twilio inbound route live", { status: 200 });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const fromRaw = String(formData.get("From") || "");
    const toRaw = String(formData.get("To") || "");
    const bodyRaw = String(formData.get("Body") || "");
    const messageSid = String(formData.get("MessageSid") || "");
    const messagingServiceSid = String(formData.get("MessagingServiceSid") || "");
    const accountSid = String(formData.get("AccountSid") || "");
    const optOutTypeRaw = String(formData.get("OptOutType") || "");

    const from = toE164(fromRaw);
    const to = toE164(toRaw);
    const body = String(bodyRaw || "").trim();
    const normalizedBody = normalizeKeyword(body);
    const optOutType = normalizeKeyword(optOutTypeRaw);

    if (!from || !to) {
      console.error("Missing From or To number.");
      return xmlResponse();
    }

    let eventType = "MESSAGE";

    if (optOutType === "STOP" || STOP_KEYWORDS.has(normalizedBody)) {
      eventType = "STOP";
    } else if (optOutType === "START" || START_KEYWORDS.has(normalizedBody)) {
      eventType = "START";
    } else if (optOutType === "HELP" || HELP_KEYWORDS.has(normalizedBody)) {
      eventType = "HELP";
    }

    const usersSnap = await adminDb
      .collection("users")
      .where("twilioNumber", "==", to)
      .limit(1)
      .get();

    if (usersSnap.empty) {
      console.error("No user found for Twilio number:", to);
      return xmlResponse();
    }

    const userDoc = usersSnap.docs[0];
    const ownerUid = userDoc.id;
    const userData = userDoc.data() || {};

    if (userData.isActive !== true) {
      console.error("Mapped user account is inactive:", ownerUid);
      return xmlResponse();
    }

    const ownerEmail = String(userData.email || "");
    const ownerName = String(userData.name || "");
    const ownerRole = String(userData.role || "user");

    const conversationId = `${ownerUid}_${phoneDocId(from)}`;
    const blacklistDocId = `${ownerUid}_${phoneDocId(from)}`;

    const convoRef = adminDb.collection("conversations").doc(conversationId);
    const convoSnap = await convoRef.get();
    const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

    const existingName = String(convoData.name || "");
    const existingFirstOutboundAt = convoData.firstOutboundAt || null;
    const existingLastOutboundAt = convoData.lastOutboundAt || null;

    await adminDb.collection("replies").add({
      ownerUid,
      ownerEmail,
      ownerName,
      ownerRole,
      phone: from,
      from,
      to,
      body,
      normalizedBody,
      direction: "inbound",
      status: "received",
      read: false,
      messageSid,
      messagingServiceSid,
      accountSid,
      twilioNumber: to,
      optOutType: optOutType || null,
      eventType,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const convoMessageId = messageSid || adminDb.collection("_tmp").doc().id;
    const convoMessageRef = convoRef.collection("messages").doc(convoMessageId);

    await convoMessageRef.set({
      sid: messageSid || "",
      ownerUid,
      ownerEmail,
      ownerName,
      ownerRole,
      phone: from,
      from,
      to,
      body,
      normalizedBody,
      direction: "inbound",
      status: "received",
      read: false,
      eventType,
      optOutType: optOutType || null,
      messagingServiceSid: messagingServiceSid || "",
      accountSid: accountSid || "",
      twilioNumber: to,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await convoRef.set(
      {
        ownerUid,
        ownerEmail,
        ownerName,
        ownerRole,
        phone: from,
        name: existingName,
        twilioNumber: to,
        assignedTwilioNumber: to,
        messagingServiceSid: messagingServiceSid || "",
        lastMessage: body,
        lastDirection: "inbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),

        status: "replied",
        hasReply: true,
        unreadCount: FieldValue.increment(1),
        replyCount: FieldValue.increment(1),
        messageCount: FieldValue.increment(1),

        firstOutboundAt: existingFirstOutboundAt || null,
        lastOutboundAt: existingLastOutboundAt || null,
        lastInboundAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const blacklistRef = adminDb
      .collection("blacklisted_numbers")
      .doc(blacklistDocId);

    const blacklistEventRef = adminDb.collection("blacklist_events").doc();

    if (eventType === "STOP") {
      await blacklistRef.set(
        {
          ownerUid,
          ownerEmail,
          ownerName,
          phone: from,
          twilioNumber: to,
          status: "blocked",
          source: "twilio_inbound",
          reason: "user_opt_out",
          lastKeyword: optOutType || normalizedBody || "STOP",
          lastBody: body,
          lastMessageSid: messageSid || null,
          messagingServiceSid: messagingServiceSid || null,
          blockedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          unblockedAt: null,
        },
        { merge: true }
      );

      await blacklistEventRef.set({
        ownerUid,
        ownerEmail,
        ownerName,
        phone: from,
        twilioNumber: to,
        eventType: "STOP",
        body,
        normalizedBody,
        messageSid: messageSid || null,
        messagingServiceSid: messagingServiceSid || null,
        createdAt: FieldValue.serverTimestamp(),
      });
    } else if (eventType === "START") {
      await blacklistRef.set(
        {
          ownerUid,
          ownerEmail,
          ownerName,
          phone: from,
          twilioNumber: to,
          status: "active",
          source: "twilio_inbound",
          reason: "user_opt_in",
          lastKeyword: optOutType || normalizedBody || "START",
          lastBody: body,
          lastMessageSid: messageSid || null,
          messagingServiceSid: messagingServiceSid || null,
          unblockedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await blacklistEventRef.set({
        ownerUid,
        ownerEmail,
        ownerName,
        phone: from,
        twilioNumber: to,
        eventType: "START",
        body,
        normalizedBody,
        messageSid: messageSid || null,
        messagingServiceSid: messagingServiceSid || null,
        createdAt: FieldValue.serverTimestamp(),
      });
    } else if (eventType === "HELP") {
      await blacklistEventRef.set({
        ownerUid,
        ownerEmail,
        ownerName,
        phone: from,
        twilioNumber: to,
        eventType: "HELP",
        body,
        normalizedBody,
        messageSid: messageSid || null,
        messagingServiceSid: messagingServiceSid || null,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    return xmlResponse();
  } catch (error: any) {
    console.error("Twilio inbound webhook error:", error);
    return xmlResponse();
  }
}