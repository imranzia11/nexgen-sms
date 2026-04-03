import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  const decoded = await getAuth().verifyIdToken(token);
  return decoded;
}

export async function POST(req: NextRequest) {
  try {
    const decodedUser = await getUserFromRequest(req);
    const uid = decodedUser.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return NextResponse.json(
        { ok: false, error: "User profile not found." },
        { status: 404 }
      );
    }

    const userData = userSnap.data() || {};

    if (userData.isActive !== true) {
      return NextResponse.json(
        { ok: false, error: "User account is inactive." },
        { status: 403 }
      );
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid =
      userData.messagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID;
    const twilioNumber = userData.twilioNumber || "";

    if (!accountSid || !authToken || !messagingServiceSid) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio configuration." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const to = toE164(body?.to || body?.phone || "");
    const messageBody = String(body?.body || "").trim();

    if (!to) {
      return NextResponse.json(
        { ok: false, error: "Recipient phone is required." },
        { status: 400 }
      );
    }

    if (!messageBody) {
      return NextResponse.json(
        { ok: false, error: "Reply body is required." },
        { status: 400 }
      );
    }

    const client = twilio(accountSid, authToken);

    const msg = await client.messages.create({
      body: messageBody,
      to,
      messagingServiceSid,
    });

    const convoId = `${uid}_${phoneDocId(to)}`;
    const convoRef = adminDb.collection("conversations").doc(convoId);
    const threadMessageRef = convoRef.collection("messages").doc(msg.sid);

    const existingConvoSnap = await convoRef.get();
    const existingConvo = existingConvoSnap.exists ? existingConvoSnap.data() || {} : {};
    const existingReplyCount = Number(existingConvo.replyCount || 0);
    const existingUnreadCount = Number(existingConvo.unreadCount || 0);
    const existingOutboundCount = Number(existingConvo.outboundCount || 0);
    const existingMessageCount = Number(existingConvo.messageCount || 0);
    const existingName = String(existingConvo.name || "");
    const existingFirstOutboundAt = existingConvo.firstOutboundAt || null;
    const existingLastInboundAt = existingConvo.lastInboundAt || null;

    await threadMessageRef.set({
      sid: msg.sid,
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      phone: to,
      from: msg.from || "",
      to,
      body: messageBody,
      direction: "outbound",
      status: msg.status || "sent",
      read: true,
      messagingServiceSid,
      twilioNumber,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await convoRef.set(
      {
        ownerUid: uid,
        ownerEmail: String(userData.email || ""),
        ownerName: String(userData.name || ""),
        ownerRole: String(userData.role || "user"),
        phone: to,
        name: existingName,
        twilioNumber,
        assignedTwilioNumber: twilioNumber,
        messagingServiceSid,
        lastMessage: messageBody,
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),

        status: existingReplyCount > 0 ? "replied" : "awaiting_reply",
        hasReply: existingReplyCount > 0,
        unreadCount: existingUnreadCount,
        replyCount: existingReplyCount,
        outboundCount: existingOutboundCount + 1,
        messageCount: existingMessageCount + 1,

        firstOutboundAt: existingFirstOutboundAt || FieldValue.serverTimestamp(),
        lastOutboundAt: FieldValue.serverTimestamp(),
        lastInboundAt: existingLastInboundAt || null,
      },
      { merge: true }
    );

    await adminDb.collection("messages").add({
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      phone: to,
      to,
      from: msg.from || "",
      body: messageBody,
      sid: msg.sid,
      status: msg.status || "sent",
      direction: "outbound",
      messagingServiceSid,
      twilioNumber,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      ok: true,
      sid: msg.sid,
      status: msg.status,
    });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Failed to send reply." },
      { status: 500 }
    );
  }
}