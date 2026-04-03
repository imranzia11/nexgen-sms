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

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    );

    const signature = req.headers.get("x-twilio-signature") || "";
    const authToken = process.env.TWILIO_AUTH_TOKEN || "";

    const appBaseUrl = process.env.APP_BASE_URL?.trim();
    const requestUrl = appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/api/send-sms/twilio`
      : req.url;

    if (authToken && signature) {
      const valid = twilio.validateRequest(
        authToken,
        signature,
        requestUrl,
        params
      );

      if (!valid) {
        console.error("Invalid Twilio signature");
        return xmlResponse();
      }
    }

    const from = toE164(String(params.From || "").trim());
    const to = toE164(String(params.To || "").trim());
    const body = String(params.Body || "").trim();
    const messageSid = String(params.MessageSid || "").trim();
    const messagingServiceSid = String(params.MessagingServiceSid || "").trim();

    if (!from || !messageSid || !to) {
      return xmlResponse();
    }

    const usersSnap = await adminDb
      .collection("users")
      .where("twilioNumber", "==", to)
      .limit(1)
      .get();

    if (usersSnap.empty) {
      console.error("No user mapped to Twilio number:", to);
      return xmlResponse();
    }

    const userDoc = usersSnap.docs[0];
    const ownerUid = userDoc.id;
    const userData = userDoc.data() || {};

    if (userData.isActive !== true) {
      console.error("Inactive user for Twilio number:", to);
      return xmlResponse();
    }

    const convoId = `${ownerUid}_${phoneDocId(from)}`;
    const convoRef = adminDb.collection("conversations").doc(convoId);
    const messageRef = convoRef.collection("messages").doc(messageSid);

    await messageRef.set(
      {
        sid: messageSid,
        ownerUid,
        from,
        to,
        body,
        direction: "inbound",
        read: false,
        messagingServiceSid: messagingServiceSid || "",
        twilioNumber: to,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await convoRef.set(
      {
        ownerUid,
        phone: from,
        twilioNumber: to,
        messagingServiceSid: messagingServiceSid || "",
        lastMessage: body,
        lastDirection: "inbound",
        unreadCount: FieldValue.increment(1),
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return xmlResponse();
  } catch (error) {
    console.error("Inbound webhook error:", error);
    return xmlResponse();
  }
}