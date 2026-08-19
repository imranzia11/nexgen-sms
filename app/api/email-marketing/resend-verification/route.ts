import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { resendSenderVerification } from "../../../../lib/sendgridSenderIdentity";

function getBearerToken(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing authorization token." },
        { status: 401 }
      );
    }

    const decodedUser = await getAuth().verifyIdToken(token);
    const uid = decodedUser.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};

    if (userData.isActive !== true) {
      return NextResponse.json(
        { ok: false, error: "This account is not active." },
        { status: 403 }
      );
    }

    const senderId = userData.senderId;

    if (typeof senderId !== "number") {
      return NextResponse.json(
        { ok: false, error: "No pending sender identity found for this account." },
        { status: 400 }
      );
    }

    await resendSenderVerification(senderId);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("resend-verification failed", err?.message || err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to resend verification email." },
      { status: 500 }
    );
  }
}
