import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164, phoneDocId } from "../../../../lib/phone";
import { isGloballyBlocked } from "../../../../lib/globalBlocklist";

// Twilio calls this (the TwiML App's Voice Request URL) when a signed-in
// account starts an outbound call from the browser. It decides what the call
// does:
//  - the account is identified by the token identity Twilio puts in `From`
//    ("client:<uid>") - never by anything the browser sends in the request
//  - the caller ID is ALWAYS that account's own Twilio number
//  - numbers on the platform-wide opt-out list or the account's own
//    blacklist are refused
// The result is dialed with <Dial>, and the call's outcome is written to
// calls/{CallSid} by /api/voice/status (the <Dial action> URL).

function twiml(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function reject(message: string) {
  return twiml(`<Say>${message}</Say><Hangup/>`);
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
      ? `${appBaseUrl.replace(/\/$/, "")}/api/voice/twiml`
      : req.url;

    if (!authToken || !signature || !twilio.validateRequest(authToken, signature, requestUrl, params)) {
      console.error("Invalid or missing Twilio voice signature");
      return reject("This call could not be completed.");
    }

    const from = String(params.From || "");
    if (!from.startsWith("client:")) {
      return reject("This call could not be completed.");
    }
    const uid = from.slice("client:".length);

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const user = userSnap.exists ? userSnap.data() || {} : {};
    if (user.isActive !== true || user.voiceEnabled !== true) {
      return reject("Calling is not enabled for this account.");
    }

    const callerId = toE164(String(user.twilioNumber || user.assignedTwilioNumber || ""));
    const to = toE164(String(params.To || ""));
    if (!callerId || !/^\+\d{8,15}$/.test(to)) {
      return reject("This call could not be completed.");
    }

    // Same rule as texting: a record only blocks while its status is
    // "blocked". Unblocking from the Replies page keeps the record and sets
    // status "active", so the mere existence of a record must not refuse
    // the call. Both checks run together to keep call setup fast.
    const [globallyBlocked, blockedSnap] = await Promise.all([
      isGloballyBlocked(to),
      adminDb
        .collection("blacklisted_numbers")
        .where("ownerUid", "==", uid)
        .where("phone", "==", to)
        .get(),
    ]);
    const isBlockedForOwner = blockedSnap.docs.some(
      (d) => String(d.data()?.status || "").toLowerCase() === "blocked"
    );
    if (globallyBlocked || isBlockedForOwner) {
      return reject("This number has opted out and cannot be contacted.");
    }

    const callSid = String(params.CallSid || "");
    if (callSid) {
      // Not awaited: the log write must not delay connecting the call.
      void adminDb.collection("calls").doc(callSid).set({
        ownerUid: uid,
        ownerEmail: String(user.email || ""),
        callSid,
        to,
        phoneDocId: phoneDocId(to),
        from: callerId,
        direction: "outbound",
        status: "initiated",
        createdAt: FieldValue.serverTimestamp(),
      }).catch((e) => console.error("Call log write failed", e));
    }

    const actionUrl = appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/api/voice/status`
      : "/api/voice/status";

    return twiml(
      `<Dial callerId="${callerId}" answerOnBridge="true" timeout="20" action="${actionUrl}" method="POST"><Number>${to}</Number></Dial>`
    );
  } catch (error) {
    console.error("Voice TwiML route failed", error);
    return reject("This call could not be completed.");
  }
}
