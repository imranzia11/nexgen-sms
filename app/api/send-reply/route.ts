import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";

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

    const client = twilio(accountSid, authToken);

    const { to, body } = await req.json();

    if (!to || !body?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Phone and body are required." },
        { status: 400 }
      );
    }

    const msg = await client.messages.create({
      to,
      body: body.trim(),
      messagingServiceSid,
    });

    const convoId = `${uid}_${phoneDocId(to)}`;
    const convoRef = adminDb.collection("conversations").doc(convoId);
    const messageRef = convoRef.collection("messages").doc(msg.sid);

    await messageRef.set({
      sid: msg.sid,
      from: msg.from || "",
      to,
      body: body.trim(),
      direction: "outbound",
      status: msg.status || "queued",
      read: true,
      ownerUid: uid,
      messagingServiceSid,
      twilioNumber,
      createdAt: FieldValue.serverTimestamp(),
    });

    await convoRef.set(
      {
        ownerUid: uid,
        phone: to,
        lastMessage: body.trim(),
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        messagingServiceSid,
        twilioNumber,
      },
      { merge: true }
    );

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