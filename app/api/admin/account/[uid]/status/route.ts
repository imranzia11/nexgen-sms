import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";

// Superadmin-only: enable or disable one account.
//
// Disabling does two things so the account really can't get in:
//  1. users/{uid}.isActive = false - every page and the login screen already
//     check this and sign the user straight back out.
//  2. The Firebase Auth user is disabled and its refresh tokens revoked, so
//     the sign-in itself is refused and any already-open session stops
//     refreshing. (Clients can't change isActive themselves - see the
//     users/{userId} rule in firestore.rules.)
// Enabling reverses both. Superadmin accounts can't be changed here, and a
// superadmin can't disable themselves.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  try {
    const decoded = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};

    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { uid } = await params;
    const body = await req.json().catch(() => ({}));

    if (typeof body?.isActive !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "isActive (true/false) is required." },
        { status: 400 }
      );
    }
    const isActive: boolean = body.isActive;

    if (uid === decoded.uid) {
      return NextResponse.json(
        { ok: false, error: "You can't change your own account." },
        { status: 400 }
      );
    }

    const targetRef = adminDb.collection("users").doc(uid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      return NextResponse.json({ ok: false, error: "Account not found." }, { status: 404 });
    }
    if (String(targetSnap.data()?.role || "").toLowerCase() === "superadmin") {
      return NextResponse.json(
        { ok: false, error: "Superadmin accounts can't be changed here." },
        { status: 400 }
      );
    }

    await targetRef.set(
      {
        isActive,
        statusUpdatedAt: FieldValue.serverTimestamp(),
        statusUpdatedBy: decoded.uid,
      },
      { merge: true }
    );

    // Best-effort on the Auth side: an account that exists in Firestore but
    // not in Auth shouldn't make the toggle fail.
    let authUpdated = true;
    try {
      await getAuth().updateUser(uid, { disabled: !isActive });
      if (!isActive) {
        await getAuth().revokeRefreshTokens(uid);
      }
    } catch (authError) {
      authUpdated = false;
      console.error("Auth update failed for account status change", authError);
    }

    return NextResponse.json({ ok: true, uid, isActive, authUpdated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
