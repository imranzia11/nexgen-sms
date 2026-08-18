import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { getSenderIdentity } from "../../../../lib/sendgridSenderIdentity";

// Tells the Email Marketing page whether the signed-in account already has
// a working sender identity - this is what lets a returning user skip
// re-confirming their email every visit. Status is tied to the account
// (stored on their Firestore user doc), not the browser, so it works the
// same on any device they log in from.
//
// Three possible states:
//   "none"     - no sender set up yet, show the create-sender form
//   "pending"  - a sender identity exists but SendGrid hasn't seen the
//                confirmation click yet
//   "verified" - ready to send, unlock the page immediately

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

    const senderEmail = String(userData.senderEmail || "").trim();
    const senderId = userData.senderId;

    if (!senderEmail) {
      return NextResponse.json({ ok: true, status: "none" });
    }

    // Sender identities created through the new self-serve flow have a
    // senderId we can poll SendGrid with for a live status. Older accounts
    // set up via tools/set-sender-email.ts before this existed have no
    // senderId - those were already confirmed working manually, so trust
    // what's on file rather than requiring them to redo anything.
    if (typeof senderId !== "number") {
      return NextResponse.json({
        ok: true,
        status: "verified",
        senderEmail,
        senderName: String(userData.senderName || "").trim(),
      });
    }

    let verified = userData.senderVerified === true;

    if (!verified) {
      try {
        const identity = await getSenderIdentity(senderId);
        verified = identity.verified === true;
        if (verified) {
          await adminDb.collection("users").doc(uid).set(
            { senderVerified: true },
            { merge: true }
          );
        }
      } catch (checkErr) {
        // If SendGrid is unreachable or the check fails, fall back to
        // whatever's already on file rather than blocking the page.
        console.error("sender-status: SendGrid check failed (non-fatal)", checkErr);
      }
    }

    return NextResponse.json({
      ok: true,
      status: verified ? "verified" : "pending",
      senderEmail,
      senderName: String(userData.senderName || "").trim(),
      senderId,
    });
  } catch (err: any) {
    console.error("sender-status failed", err?.message || err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to check sender status." },
      { status: 500 }
    );
  }
}
