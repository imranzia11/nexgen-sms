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

function normalizeMediaUrls(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((url) => /^https:\/\//i.test(url));
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
    const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

    const twilioNumber = toE164(
      String(userData.twilioNumber || userData.assignedTwilioNumber || "")
    );

    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio configuration." },
        { status: 500 }
      );
    }

    if (!appBaseUrl) {
      return NextResponse.json(
        { ok: false, error: "APP_BASE_URL is missing." },
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
    const mediaUrls = normalizeMediaUrls(reqBody?.mediaUrls);

    if (!to) {
      return NextResponse.json(
        { ok: false, error: "Recipient phone is required." },
        { status: 400 }
      );
    }

    if (!messageBody && mediaUrls.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Reply body or media is required." },
        { status: 400 }
      );
    }

    if (
      Array.isArray(reqBody?.mediaUrls) &&
      reqBody.mediaUrls.length > 0 &&
      mediaUrls.length === 0
    ) {
      return NextResponse.json(
        { ok: false, error: "All media URLs are invalid. Use public HTTPS URLs." },
        { status: 400 }
      );
    }

    const blocked = await isBlockedNumber(uid, to);
    if (blocked) {
      return NextResponse.json(
        {
          ok: false,
          error: "This number is blocked or opted out and cannot receive messages.",
        },
        { status: 400 }
      );
    }

    const client = twilio(accountSid, authToken);

const messagingServiceSid = String(
  userData.messagingServiceSid || ""
).trim();

if (!messagingServiceSid) {
  return NextResponse.json(
    { ok: false, error: "Messaging Service SID is missing." },
    { status: 400 }
  );
}

const twilioPayload: {
  body?: string;
  to: string;
  messagingServiceSid: string;
  statusCallback: string;
  mediaUrl?: string[];
} = {
  to,
  messagingServiceSid,
  statusCallback: `${appBaseUrl}/api/send-sms/twilio/status`,
};

if (messageBody) {
  twilioPayload.body = messageBody;
}

if (mediaUrls.length > 0) {
  twilioPayload.mediaUrl = mediaUrls;
}

const msg = await client.messages.create(twilioPayload);

    const conversationId = `${uid}_${phoneDocId(to)}`;
    const convoRef = adminDb.collection("conversations").doc(conversationId);
    const threadMessageRef = convoRef.collection("messages").doc(msg.sid);

    const convoSnap = await convoRef.get();
    const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

    const existingUnreadCount = Number(convoData.unreadCount || 0);
    const existingReplyCount = Number(convoData.replyCount || 0);
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
      mediaUrls,
      numMedia: mediaUrls.length,
      direction: "outbound",
      status: msg.status || "queued",
      read: true,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      conversationId,
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
        lastMessage: messageBody || (mediaUrls.length > 0 ? "Sent media" : ""),
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: existingHasReply ? "replied" : "awaiting_reply",
        hasReply: existingHasReply,
        unreadCount: existingUnreadCount,
        replyCount: existingReplyCount,
        outboundCount: FieldValue.increment(1),
        messageCount: FieldValue.increment(1),
        firstOutboundAt: existingFirstOutboundAt || FieldValue.serverTimestamp(),
        lastOutboundAt: FieldValue.serverTimestamp(),
        lastInboundAt: existingLastInboundAt || null,
        lastOutboundStatus: msg.status || "queued",
      },
      { merge: true }
    );

    await adminDb.collection("messages").add({
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      conversationId,
      phone: to,
      to,
      from: msg.from || twilioNumber,
      body: messageBody,
      mediaUrls,
      numMedia: mediaUrls.length,
      sid: msg.sid,
      twilioSid: msg.sid,
      status: msg.status || "queued",
      direction: "outbound",
      read: true,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      error: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      ok: true,
      sid: msg.sid,
      status: msg.status || "queued",
      conversationId,
      mediaUrls,
    });
  } catch (error: any) {
    console.error("send-reply error:", error);

    return NextResponse.json(
      { ok: false, error: error?.message || "Failed to send reply." },
      { status: 500 }
    );
  }
}