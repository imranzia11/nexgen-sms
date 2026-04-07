import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      "Cache-Control": "no-store",
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

  const payload = {
    ownerUid,
    phone,
    twilioNumber,
    assignedTwilioNumber: twilioNumber,
    status: keyword === "START" ? "active" : "blocked",
    source: "twilio_inbound",
    keyword,
    lastMessageSid: messageSid,
    updatedAt: FieldValue.serverTimestamp(),
    blockedAt: keyword === "STOP" ? FieldValue.serverTimestamp() : null,
    unblockedAt: keyword === "START" ? FieldValue.serverTimestamp() : null,
  };

  if (!existing.empty) {
    await existing.docs[0].ref.set(payload, { merge: true });
    return;
  }

  await adminDb.collection("blacklisted_numbers").add({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function getBlockedStatus(ownerUid: string, phone: string) {
  const snap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) return false;

  const data = snap.docs[0].data() || {};
  return String(data.status || "").toLowerCase() === "blocked";
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
    const messageSid = String(params.MessageSid || "").trim();
    const smsStatus = String(params.SmsStatus || "received").trim() || "received";
    const messagingServiceSid = String(params.MessagingServiceSid || "").trim();

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
    const replyRef = adminDb.collection("replies").doc(messageSid);

    const [convoSnap, existingThreadMsgSnap, existingReplySnap] =
      await Promise.all([convoRef.get(), threadMessageRef.get(), replyRef.get()]);

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

    const blockedNow = await getBlockedStatus(uid, from);
    const shouldBeBlockedAfterThisMessage = isStop
      ? true
      : isStart
      ? false
      : blockedNow;

    const inboundMessageData = {
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
      messagingServiceSid,
      keyword: isStop || isStart || isHelp ? keyword : "",
      blockedAfterMessage: shouldBeBlockedAfterThisMessage,
      createdAt: existingThreadMsgSnap.exists
        ? existingThreadMsgSnap.data()?.createdAt || FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const replyData = {
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
      messagingServiceSid,
      keyword: isStop || isStart || isHelp ? keyword : "",
      blockedAfterMessage: shouldBeBlockedAfterThisMessage,
      createdAt: existingReplySnap.exists
        ? existingReplySnap.data()?.createdAt || FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const convoUpdate: Record<string, unknown> = {
      ownerUid: uid,
      ownerEmail: String(user.email || ""),
      ownerName: String(user.name || ""),
      ownerRole: String(user.role || "user"),
      phone: from,
      name: existingName,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      lastMessage: body,
      lastDirection: "inbound",
      lastMessageAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      status: "replied",
      hasReply: true,
      lastInboundAt: FieldValue.serverTimestamp(),
      lastInboundSid: messageSid,
      blocked: shouldBeBlockedAfterThisMessage,
      blockedAt: isStop
        ? FieldValue.serverTimestamp()
        : existingConvo.blockedAt || null,
      unblockedAt: isStart
        ? FieldValue.serverTimestamp()
        : existingConvo.unblockedAt || null,
    };

    const isFirstInboundWrite = !existingThreadMsgSnap.exists;

    if (isFirstInboundWrite) {
      convoUpdate.unreadCount = FieldValue.increment(1);
      convoUpdate.replyCount = FieldValue.increment(1);
      convoUpdate.inboundCount = FieldValue.increment(1);
      convoUpdate.messageCount = FieldValue.increment(1);
    }

    const batch = adminDb.batch();

    batch.set(threadMessageRef, inboundMessageData, { merge: true });
    batch.set(replyRef, replyData, { merge: true });
    batch.set(convoRef, convoUpdate, { merge: true });

    await batch.commit();

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