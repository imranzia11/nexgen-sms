import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

export async function POST(req: NextRequest) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!accountSid || !authToken || !messagingServiceSid) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio environment variables." },
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

    const convoId = phoneDocId(to);
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
      createdAt: FieldValue.serverTimestamp(),
    });

    await convoRef.set(
      {
        phone: to,
        lastMessage: body.trim(),
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
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