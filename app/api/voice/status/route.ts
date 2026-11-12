import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";

// <Dial action> callback: Twilio posts here when the dialed leg ends, with
// DialCallStatus (completed / no-answer / busy / failed / canceled) and
// DialCallDuration (seconds). Records the outcome on calls/{CallSid}.

function emptyResponse() {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    );

    const authToken = process.env.TWILIO_AUTH_TOKEN || "";
    const signature = req.headers.get("x-twilio-signature") || "";
    const appBaseUrl = process.env.APP_BASE_URL?.trim();
    const requestUrl = appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/api/voice/status`
      : req.url;

    if (!authToken || !signature || !twilio.validateRequest(authToken, signature, requestUrl, params)) {
      console.error("Invalid or missing Twilio voice status signature");
      return emptyResponse();
    }

    const callSid = String(params.CallSid || "");
    if (!callSid) return emptyResponse();

    const status = String(params.DialCallStatus || "completed").toLowerCase();
    const duration = Number(params.DialCallDuration) || 0;

    await adminDb
      .collection("calls")
      .doc(callSid)
      .set(
        {
          status,
          durationSeconds: duration,
          endedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    return emptyResponse();
  } catch (error) {
    console.error("Voice status route failed", error);
    return emptyResponse();
  }
}
