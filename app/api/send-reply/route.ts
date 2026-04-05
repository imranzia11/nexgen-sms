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
    const twilioNumber = toE164(
      String(userData.twilioNumber || userData.assignedTwilioNumber || "")
    );

    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio configuration." },
        { status: 500 }
      );
    }

    if (!twilioNumber) {
      return NextResponse.json(
        { ok: false, error: "No Twilio number is assigned to this user." },
        { status: 400 }
      );
    }

    const reqBody = await req.json();
    const to = toE164(reqBody?.to || reqBody?.phone || "");
    const messageBody = String(reqBody?.body || "").trim();

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
      from: twilioNumber,
    });

    const conversationId = `${uid}_${phoneDocId(to)}`;
    const convoRef = adminDb.collection("conversations").doc(conversationId);
    const threadMessageRef = convoRef.collection("messages").doc(msg.sid);

    const convoSnap = await convoRef.get();
    const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

    const existingReplyCount = Number(convoData.replyCount || 0);
    const existingUnreadCount = Number(convoData.unreadCount || 0);
    const existingOutboundCount = Number(convoData.outboundCount || 0);
    const existingMessageCount = Number(convoData.messageCount || 0);
    const existingName = String(convoData.name || "");
    const existingFirstOutboundAt = convoData.firstOutboundAt || null;
    const existingLastInboundAt = convoData.lastInboundAt || null;
    const existingHasReply = convoData.hasReply === true;

    await threadMessageRef.set({
      sid: msg.sid,
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      phone: to,
      from: msg.from || twilioNumber,
      to,
      body: messageBody,
      direction: "outbound",
      status: msg.status || "sent",
      read: true,
      twilioNumber,
      messagingServiceSid: "",
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
        messagingServiceSid: "",
        lastMessage: messageBody,
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: existingHasReply ? "replied" : "awaiting_reply",
        hasReply: existingHasReply,
        unreadCount: existingUnreadCount,
        replyCount: existingReplyCount,
        outboundCount: existingOutboundCount + 1,
        messageCount: existingMessageCount + 1,
        firstOutboundAt:
          existingFirstOutboundAt || FieldValue.serverTimestamp(),
        lastOutboundAt: FieldValue.serverTimestamp(),
        lastInboundAt: existingLastInboundAt || null,
      },
      { merge: true }
    );

    await adminDb.collection("messages").add({
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      phone: to,
      to,
      from: msg.from || twilioNumber,
      body: messageBody,
      sid: msg.sid,
      status: msg.status || "sent",
      direction: "outbound",
      twilioNumber,
      messagingServiceSid: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      ok: true,
      sid: msg.sid,
      status: msg.status || "sent",
    });
  } catch (error: any) {
    console.error("send-reply error:", error);

    return NextResponse.json(
      { ok: false, error: error?.message || "Failed to send reply." },
      { status: 500 }
    );
  }
}