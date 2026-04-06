import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

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
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
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
        { ok: false, error: "Missing Twilio account configuration." },
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

    const body = await req.json();

    const phone = toE164(body.phone || body.to || "");
    const message = String(body.message || body.body || "").trim();
    const customerName = String(body.name || "").trim();

    if (!phone) {
      return NextResponse.json(
        { ok: false, error: "Customer phone is required." },
        { status: 400 }
      );
    }

    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Reply message is required." },
        { status: 400 }
      );
    }

    const blacklistSnap = await adminDb
      .collection("blacklisted_numbers")
      .where("ownerUid", "==", uid)
      .where("phone", "==", phone)
      .limit(1)
      .get();

    if (!blacklistSnap.empty) {
      const blacklistData = blacklistSnap.docs[0].data() || {};
      if (String(blacklistData.status || "").toLowerCase() === "blocked") {
        return NextResponse.json(
          {
            ok: false,
            error: "This number is blocked and cannot receive messages.",
          },
          { status: 400 }
        );
      }
    }

    const client = twilio(accountSid, authToken);

    const res = await client.messages.create({
      body: message,
      to: phone,
      from: twilioNumber,
      statusCallback: `${appBaseUrl}/api/send-sms/twilio/status`,
    });

    const conversationId = `${uid}_${phoneDocId(phone)}`;
    const convoRef = adminDb.collection("conversations").doc(conversationId);
    const threadMessageRef = convoRef.collection("messages").doc(res.sid);

    const existingConvoSnap = await convoRef.get();
    const existingConvo = existingConvoSnap.exists
      ? existingConvoSnap.data() || {}
      : {};

    const existingUnreadCount = Number(existingConvo.unreadCount || 0);
    const existingReplyCount = Number(existingConvo.replyCount || 0);
    const existingHasReply = existingConvo.hasReply === true;
    const existingName =
      String(existingConvo.name || "").trim() || customerName || "";

    await threadMessageRef.set({
      sid: res.sid,
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      conversationId,
      from: res.from || twilioNumber,
      to: phone,
      phone,
      body: message,
      direction: "outbound",
      status: res.status || "queued",
      read: true,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
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
        phone,
        name: existingName,
        twilioNumber,
        assignedTwilioNumber: twilioNumber,
        messagingServiceSid: "",
        lastMessage: message,
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: existingHasReply ? "replied" : "awaiting_reply",
        hasReply: existingHasReply,
        unreadCount: existingUnreadCount,
        replyCount: existingReplyCount,
        outboundCount: FieldValue.increment(1),
        messageCount: FieldValue.increment(1),
        firstOutboundAt:
          existingConvo.firstOutboundAt || FieldValue.serverTimestamp(),
        lastOutboundAt: FieldValue.serverTimestamp(),
        lastInboundAt: existingConvo.lastInboundAt || null,
        lastOutboundStatus: res.status || "queued",
      },
      { merge: true }
    );

    await adminDb.collection("messages").add({
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      conversationId,
      name: existingName,
      phone,
      to: phone,
      from: res.from || twilioNumber,
      body: message,
      sid: res.sid,
      twilioSid: res.sid,
      status: res.status || "queued",
      direction: "outbound",
      read: true,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid: "",
      sourceFileName: "",
      error: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      ok: true,
      sid: res.sid,
      status: res.status || "queued",
      phone,
      conversationId,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Unexpected server error",
      },
      { status: 500 }
    );
  }
}