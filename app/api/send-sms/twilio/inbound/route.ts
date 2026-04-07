import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

function xmlResponse(message?: string) {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
        message
      )}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function escapeXml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function normalizeKeyword(value: string) {
  return String(value || "").trim().toUpperCase();
}

function buildConversationId(uid: string, customerPhone: string) {
  return `${uid}_${phoneDocId(customerPhone)}`;
}

async function findOwnerByTwilioNumber(inboundTo: string) {
  const normalizedTo = toE164(inboundTo);
  if (!normalizedTo) return null;

  let snap = await adminDb
    .collection("users")
    .where("twilioNumber", "==", normalizedTo)
    .limit(1)
    .get();

  if (snap.empty) {
    snap = await adminDb
      .collection("users")
      .where("assignedTwilioNumber", "==", normalizedTo)
      .limit(1)
      .get();
  }

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data() || {};

  if (data.isActive !== true) return null;

  return {
    uid: doc.id,
    user: data,
    twilioNumber: normalizedTo,
  };
}

async function upsertBlacklist(opts: {
  ownerUid: string;
  phone: string;
  keyword: string;
  twilioNumber: string;
  messageSid: string;
}) {
  const { ownerUid, phone, keyword, twilioNumber, messageSid } = opts;

  const existing = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (!existing.empty) {
    await existing.docs[0].ref.set(
      {
        ownerUid,
        phone,
        twilioNumber,
        assignedTwilioNumber: twilioNumber,
        status: keyword === "START" ? "active" : "blocked",
        source: "twilio_inbound",
        keyword,
        lastMessageSid: messageSid,
        updatedAt: FieldValue.serverTimestamp(),
        unblockedAt:
          keyword === "START" ? FieldValue.serverTimestamp() : null,
        blockedAt: keyword === "STOP" ? FieldValue.serverTimestamp() : null,
      },
      { merge: true }
    );
    return;
  }

  await adminDb.collection("blacklisted_numbers").add({
    ownerUid,
    phone,
    twilioNumber,
    assignedTwilioNumber: twilioNumber,
    status: keyword === "START" ? "active" : "blocked",
    source: "twilio_inbound",
    keyword,
    lastMessageSid: messageSid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    unblockedAt: keyword === "START" ? FieldValue.serverTimestamp() : null,
    blockedAt: keyword === "STOP" ? FieldValue.serverTimestamp() : null,
  });
}

async function isBlockedNumber(ownerUid: string, phone: string) {
  const snap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) return false;

  return snap.docs.some((doc) => {
    const data = doc.data() || {};
    return String(data.status || "").toLowerCase() === "blocked";
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    );

    const signature = req.headers.get("x-twilio-signature") || "";
    const authToken = process.env.TWILIO_AUTH_TOKEN || "";
    const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

    const requestUrl = appBaseUrl
      ? `${appBaseUrl}/api/send-sms/twilio/inbound`
      : req.url;

    if (authToken && signature) {
      const isValid = twilio.validateRequest(
        authToken,
        signature,
        requestUrl,
        params
      );

      if (!isValid) {
        console.error("Invalid Twilio signature", {
          requestUrl,
          from: params.From,
          to: params.To,
          sid: params.MessageSid,
        });

        return new Response("Invalid signature", { status: 403 });
      }
    }

    const from = toE164(params.From || "");
    const to = toE164(params.To || "");
    const body = String(params.Body || "").trim();
    const messageSid = String(params.MessageSid || "");
    const smsStatus = String(params.SmsStatus || "received").trim() || "received";

    if (!from || !to || !messageSid) {
      console.error("Inbound webhook missing required fields", {
        from,
        to,
        messageSid,
      });
      return xmlResponse();
    }

    const owner = await findOwnerByTwilioNumber(to);

    if (!owner) {
      console.error("No active user found for inbound Twilio number", {
        to,
        from,
        messageSid,
      });
      return xmlResponse();
    }

    const { uid, user, twilioNumber } = owner;
    const conversationId = buildConversationId(uid, from);
    const convoRef = adminDb.collection("conversations").doc(conversationId);
    const threadMessageRef = convoRef.collection("messages").doc(messageSid);

    const convoSnap = await convoRef.get();
    const existingConvo = convoSnap.exists ? convoSnap.data() || {} : {};

    const existingName = String(existingConvo.name || "").trim();
    const keyword = normalizeKeyword(body);
    const isStop = keyword === "STOP";
    const isStart = keyword === "START";
    const isHelp = keyword === "HELP";

    if (isStop || isStart) {
      await upsertBlacklist({
        ownerUid: uid,
        phone: from,
        keyword,
        twilioNumber,
        messageSid,
      });
    }

    const currentlyBlocked = await isBlockedNumber(uid, from);
    const shouldBeBlockedAfterThisMessage = isStop
      ? true
      : isStart
      ? false
      : currentlyBlocked;

    await threadMessageRef.set(
      {
        sid: messageSid,
        twilioSid: messageSid,
        ownerUid: uid,
        ownerEmail: String(user.email || ""),
        ownerName: String(user.name || ""),
        ownerRole: String(user.role || "user"),
        conversationId,
        from,
        to: twilioNumber,
        phone: from,
        body,
        direction: "inbound",
        status: smsStatus,
        read: false,
        twilioNumber,
        assignedTwilioNumber: twilioNumber,
        messagingServiceSid: String(params.MessagingServiceSid || ""),
        keyword: isStop || isStart || isHelp ? keyword : "",
        blockedAfterMessage: shouldBeBlockedAfterThisMessage,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await convoRef.set(
      {
        ownerUid: uid,
        ownerEmail: String(user.email || ""),
        ownerName: String(user.name || ""),
        ownerRole: String(user.role || "user"),
        phone: from,
        name: existingName,
        twilioNumber,
        assignedTwilioNumber: twilioNumber,
        messagingServiceSid: String(params.MessagingServiceSid || ""),
        lastMessage: body,
        lastDirection: "inbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: "replied",
        hasReply: true,
        unreadCount: FieldValue.increment(1),
        replyCount: FieldValue.increment(1),
        inboundCount: FieldValue.increment(1),
        messageCount: FieldValue.increment(1),
        lastInboundAt: FieldValue.serverTimestamp(),
        lastInboundSid: messageSid,
        blocked: shouldBeBlockedAfterThisMessage,
        blockedAt: isStop ? FieldValue.serverTimestamp() : existingConvo.blockedAt || null,
        unblockedAt:
          isStart ? FieldValue.serverTimestamp() : existingConvo.unblockedAt || null,
      },
      { merge: true }
    );

    await adminDb.collection("replies").add({
      ownerUid: uid,
      ownerEmail: String(user.email || ""),
      ownerName: String(user.name || ""),
      ownerRole: String(user.role || "user"),
      conversationId,
      name: existingName,
      phone: from,
      from,
      to: twilioNumber,
      body,
      sid: messageSid,
      twilioSid: messageSid,
      status: smsStatus,
      direction: "inbound",
      read: false,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid: String(params.MessagingServiceSid || ""),
      keyword: isStop || isStart || isHelp ? keyword : "",
      blockedAfterMessage: shouldBeBlockedAfterThisMessage,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (isStop) {
      return xmlResponse(
        "You have successfully opted out. You will not receive further messages."
      );
    }

    if (isStart) {
      return xmlResponse(
        "You have been re-subscribed and can receive messages again."
      );
    }

    if (isHelp) {
      return xmlResponse(
        "Reply STOP to unsubscribe. Reply START to re-subscribe."
      );
    }

    return xmlResponse();
  } catch (err: any) {
    console.error("Inbound Twilio webhook error", err);
    return xmlResponse();
  }
}