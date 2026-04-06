import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

function xmlResponse() {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
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

    const appBaseUrl = process.env.APP_BASE_URL?.trim();
    const requestUrl = appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/api/send-sms/twilio/status`
      : req.url;

    if (authToken && signature) {
      const valid = twilio.validateRequest(
        authToken,
        signature,
        requestUrl,
        params
      );

      if (!valid) {
        console.error("Invalid Twilio status callback signature");
        return xmlResponse();
      }
    }

    const messageSid = String(params.MessageSid || "").trim();
    const messageStatus = String(params.MessageStatus || "").trim().toLowerCase();
    const errorCode = String(params.ErrorCode || "").trim();
    const errorMessage = String(params.ErrorMessage || "").trim();

    if (!messageSid || !messageStatus) {
      return xmlResponse();
    }

    const now = FieldValue.serverTimestamp();
    const finalError =
      errorMessage ||
      ((messageStatus === "failed" || messageStatus === "undelivered")
        ? errorCode
        : "");

    const rootMessagesSnap = await adminDb
      .collection("messages")
      .where("sid", "==", messageSid)
      .get();

    for (const docSnap of rootMessagesSnap.docs) {
      await docSnap.ref.set(
        {
          status: messageStatus,
          error: finalError,
          errorCode: errorCode || "",
          statusUpdatedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    const conversationMessagesSnap = await adminDb
      .collectionGroup("messages")
      .where("sid", "==", messageSid)
      .get();

    let conversationRef: FirebaseFirestore.DocumentReference | null = null;

    for (const docSnap of conversationMessagesSnap.docs) {
      await docSnap.ref.set(
        {
          status: messageStatus,
          error: finalError,
          errorCode: errorCode || "",
          statusUpdatedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      if (!conversationRef) {
        conversationRef = docSnap.ref.parent.parent;
      }
    }

    if (conversationRef) {
      const patch: Record<string, unknown> = {
        updatedAt: now,
        lastOutboundStatus: messageStatus,
      };

      if (messageStatus === "failed" || messageStatus === "undelivered") {
        patch.status = "delivery_issue";
      } else if (messageStatus === "sent" || messageStatus === "delivered") {
        patch.status = "replied";
      }

      await conversationRef.set(patch, { merge: true });
    }

    return xmlResponse();
  } catch (error) {
    console.error("Twilio status callback error:", error);
    return xmlResponse();
  }
}