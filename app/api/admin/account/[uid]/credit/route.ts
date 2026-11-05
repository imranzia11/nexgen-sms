import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../../../lib/firebaseAdmin";
import { setPrepaidCredit, CreditError } from "../../../../../../lib/billingCredit";

// Superadmin-only: set an account's prepaid credit (e.g. 500 -> $500.00).
// Same one-time lock as the account's own Billing page - see
// lib/billingCredit.ts. Once locked, further changes are refused with "Seek
// admin permission to add balance." until the lock is cleared directly in
// Firestore (billingCreditLocked).

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
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
      return fail("Forbidden.", 403);
    }

    const { uid } = await params;
    const body = await req.json().catch(() => ({}));

    const result = await setPrepaidCredit({
      uid,
      amount: Number(body?.amount),
      actorUid: decoded.uid,
      source: "admin",
    });

    return NextResponse.json({ ok: true, uid, creditTotal: result.creditTotal });
  } catch (error: unknown) {
    if (error instanceof CreditError) return fail(error.message, error.status);
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error("Set credit failed", error);
    return fail(message, 500);
  }
}
