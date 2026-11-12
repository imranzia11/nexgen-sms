import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import twilio from "twilio";
import { adminDb } from "../../../../lib/firebaseAdmin";

// Short-lived Twilio Voice access token for the signed-in account's browser.
// Only accounts with users/{uid}.voiceEnabled === true (set via the Admin
// SDK / Firestore console, locked from client edits in firestore.rules) get
// one, so calling can be switched on per account. The token's identity is
// the account's own uid - the TwiML route reads it back to decide which
// number the call goes out from, so the browser can never pick a caller ID.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

export async function GET(req: NextRequest) {
  try {
    const decoded = await getUserFromRequest(req);
    const uid = decoded.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    if (userData.isActive !== true || userData.voiceEnabled !== true) {
      return NextResponse.json({ ok: true, enabled: false });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;

    if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
      return NextResponse.json(
        { ok: false, error: "Voice calling is not configured." },
        { status: 500 }
      );
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const accessToken = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity: uid,
      ttl: 3600,
    });
    accessToken.addGrant(
      new VoiceGrant({ outgoingApplicationSid: twimlAppSid, incomingAllow: false })
    );

    return NextResponse.json({
      ok: true,
      enabled: true,
      token: accessToken.toJwt(),
      expiresInSeconds: 3600,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
