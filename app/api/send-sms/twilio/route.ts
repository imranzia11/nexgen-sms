import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";

function xmlResponse() {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([k, v]) => [k, String(v)])
    );

    const signature = req.headers.get("x-twilio-signature") || "";
    const authToken = process.env.TWILIO_AUTH_TOKEN || "";
    const baseUrl = process.env.APP_BASE_URL || "";
    const webhookUrl = `${baseUrl}/api/send-sms/twilio`;

    if (authToken && baseUrl) {
      const valid = twilio.validateRequest(authToken, signature, webhookUrl, params);
      if (!valid) {
        return xmlResponse();
      }
    }

    const from = String(params.From || "");
    const to = String(params.To || "");
    const body = String(params.Body || "");
    const messageSid = String(params.MessageSid || "");

    if (!from || !messageSid) {
      return xmlResponse();
    }

    const convoId = phoneDocId(from);
    const convoRef = adminDb.collection("conversations").doc(convoId);
    const messageRef = convoRef.collection("messages").doc(messageSid);

    await messageRef.set({
      sid: messageSid,
      from,
      to,
      body,
      direction: "inbound",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    await convoRef.set(
      {
        phone: from,
        lastMessage: body,
        lastDirection: "inbound",
        unreadCount: FieldValue.increment(1),
        lastMessageAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return xmlResponse();
  } catch (error) {
    console.error("Inbound webhook error:", error);
    return xmlResponse();
  }
}