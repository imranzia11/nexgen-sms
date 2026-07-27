import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../lib/firebaseAdmin";

// Lightweight balance check for ANY signed-in, active user - not gated to
// superadmin like /api/admin/twilio-billing (which returns a full spend
// breakdown meant for the company-wide billing view). This route only ever
// returns the single dollar figure, so there's nothing sensitive enough
// here to restrict to admins - and every rep depends on the same shared
// Twilio account, so every rep benefits from seeing it before it runs dry
// again (see: the entire account going down for lack of funds).
//
// Same direct-REST-with-Basic-Auth approach as twilio-billing/route.ts,
// for the same reason noted there - stable, documented endpoint, no SDK
// version uncertainty.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

export async function GET(req: NextRequest) {
  try {
    const decodedUser = await getUserFromRequest(req);

    const userSnap = await adminDb.collection("users").doc(decodedUser.uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    if (!userSnap.exists || userData.isActive !== true) {
      return NextResponse.json({ ok: false, error: "Account is inactive." }, { status: 403 });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Twilio account is not configured." },
        { status: 500 }
      );
    }

    const basicAuth =
      "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const balanceRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`,
      { headers: { Authorization: basicAuth } }
    );

    if (!balanceRes.ok) {
      throw new Error(`Twilio balance request failed (${balanceRes.status})`);
    }

    const balanceJson = await balanceRes.json();

    return NextResponse.json({
      ok: true,
      amount: parseFloat(balanceJson.balance || "0") || 0,
      currency: String(balanceJson.currency || "usd").toLowerCase(),
    });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
