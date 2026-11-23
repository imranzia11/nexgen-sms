import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../../../lib/firebaseAdmin";
import { HttpError, setCallNumber } from "../../../../../../lib/callNumber";

// Superadmin-only: set an account's calling number ("" = back to the text
// number). Logic lives in lib/callNumber.ts (shared with the account-holder
// route at /api/voice/call-number).

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) throw new HttpError("Missing authorization token.", 401);
    const decoded = await getAuth().verifyIdToken(token);

    const callerSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};
    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { uid } = await params;
    const body = await req.json().catch(() => ({}));
    const result = await setCallNumber(uid, String(body?.callNumber || ""), decoded.uid);
    return NextResponse.json({ ok: true, uid, ...result });
  } catch (error: unknown) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
