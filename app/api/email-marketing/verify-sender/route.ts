import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";

// Gate before the Email Marketing page unlocks: the signed-in user re-enters
// the email address their blasts are supposed to send from, and this route
// confirms it matches the senderEmail already assigned to their account
// (assigned out-of-band by an admin via tools/set-sender-email.ts - see that
// script). This is NOT a password/second factor - it's a confirmation step
// so a rep can't accidentally send a campaign "from" the wrong identity, and
// so accounts with no sender email configured yet get a clear message
// instead of a confusing failure once they try to send.

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
    if (!userSnap.exists) {
      return NextResponse.json(
        { ok: false, error: "User profile not found." },
        { status: 404 }
      );
    }

    const userData = userSnap.data() || {};

    if (userData.isActive !== true) {
      return NextResponse.json(
        { ok: false, error: "This account is not active." },
        { status: 403 }
      );
    }

    const registeredSenderEmail = String(userData.senderEmail || "").trim();

    if (!registeredSenderEmail) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No sending email has been set up for your account yet. Contact an admin to get one assigned.",
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const enteredEmail = String(body?.email || "").trim().toLowerCase();

    if (!enteredEmail) {
      return NextResponse.json(
        { ok: false, error: "Enter your sending email address." },
        { status: 400 }
      );
    }

    if (enteredEmail !== registeredSenderEmail.toLowerCase()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "That doesn't match the sending email registered to your account.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({
      ok: true,
      senderEmail: registeredSenderEmail,
      senderName: String(userData.senderName || "").trim(),
    });
  } catch (err: any) {
    console.error("verify-sender failed", err?.message || err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to verify sending email." },
      { status: 500 }
    );
  }
}
