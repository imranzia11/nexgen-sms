import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { createSenderIdentity } from "../../../../lib/sendgridSenderIdentity";

// Self-serve sender-identity onboarding: a rep enters their own company
// email here, and this route creates the SendGrid sender identity AND
// registers it on their own user doc in one step - replacing the old
// two-step manual process (someone clicking through the SendGrid dashboard
// to add a sender, then an admin running tools/set-sender-email.ts).
// SendGrid still requires the rep to click the confirmation link it emails
// them - that step can't be skipped, it's what actually proves they own
// the inbox.

const ALLOWED_SENDER_DOMAIN = "nexgenmerchant.io";

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

    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    const name = String(body?.name || "").trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { ok: false, error: "Enter a valid email address." },
        { status: 400 }
      );
    }

    if (!email.endsWith(`@${ALLOWED_SENDER_DOMAIN}`)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Sending email must be a @${ALLOWED_SENDER_DOMAIN} company address.`,
        },
        { status: 400 }
      );
    }

    if (!name) {
      return NextResponse.json(
        { ok: false, error: "Enter a display name." },
        { status: 400 }
      );
    }

    const identity = await createSenderIdentity({ email, name });

    await adminDb.collection("users").doc(uid).set(
      {
        senderEmail: email,
        senderName: name,
        senderId: identity.id,
        senderVerified: identity.verified === true,
        senderEmailUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return NextResponse.json({
      ok: true,
      senderEmail: email,
      senderName: name,
      senderId: identity.id,
      verified: identity.verified === true,
    });
  } catch (err: any) {
    console.error("create-sender failed", err?.message || err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to create sender identity." },
      { status: 500 }
    );
  }
}
