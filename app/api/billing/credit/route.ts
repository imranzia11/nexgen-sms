import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import {
  setPrepaidCredit,
  CreditError,
  DEFAULT_SELF_CREDIT_MAX,
} from "../../../../lib/billingCredit";

// An account sets its OWN prepaid balance from its Billing page. One time
// only: after it's set the balance is locked and any further change returns
// "Seek admin permission to add balance." (an admin clears the lock in
// Firestore). The uid always comes from the verified token, never the body,
// and the amount is capped at users/{uid}.billingSelfCreditMax (default 500)
// so an account can't give itself an arbitrary balance.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const decoded = await getUserFromRequest(req);
    const uid = decoded.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};
    if (userData.isActive !== true) return fail("Forbidden.", 403);

    const rate = Number(userData.billingRatePerSms);
    if (!Number.isFinite(rate) || rate <= 0) return fail("Forbidden.", 403);

    const body = await req.json().catch(() => ({}));
    const configuredMax = Number(userData.billingSelfCreditMax);
    const maxAmount =
      Number.isFinite(configuredMax) && configuredMax > 0
        ? configuredMax
        : DEFAULT_SELF_CREDIT_MAX;

    const result = await setPrepaidCredit({
      uid,
      amount: Number(body?.amount),
      actorUid: uid,
      maxAmount,
      source: "self",
    });

    return NextResponse.json({ ok: true, creditTotal: result.creditTotal });
  } catch (error: unknown) {
    if (error instanceof CreditError) return fail(error.message, error.status);
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error("Self credit failed", error);
    return fail(message, 500);
  }
}
