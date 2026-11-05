import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";

// Superadmin-only: set an account's prepaid credit (e.g. 500 -> $500.00).
//
// The amount SETS the account's credit total and then locks it
// (billingCreditLocked). The entry is also recorded in
// users/{uid}/billingCredits. It also starts metering: billingStartedAt
// (usage is counted from then on) and a default per-SMS rate if none is set.
// Once locked, further changes are refused with "Seek admin permission to add
// balance." - the lock can only be cleared directly in Firestore.
// The account's balance = credit total - usage since billingStartedAt x rate
// (computed in /api/billing).

const DEFAULT_RATE = 0.3;
const MAX_CREDIT = 100000;

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
    const amount = Math.round(Number(body?.amount) * 100) / 100;
    const note = String(body?.note || "").trim().slice(0, 200);

    if (!Number.isFinite(amount) || amount <= 0) {
      return fail("Enter an amount greater than 0.", 400);
    }
    if (amount > MAX_CREDIT) {
      return fail(`Amount can't exceed $${MAX_CREDIT.toLocaleString("en-US")}.`, 400);
    }

    const userRef = adminDb.collection("users").doc(uid);
    const creditRef = userRef.collection("billingCredits").doc();

    const result = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("NOT_FOUND");
      const data = snap.data() || {};
      if (String(data.role || "").toLowerCase() === "superadmin") {
        throw new Error("SUPERADMIN");
      }

      // The balance is set once and then locked. Changing it again needs the
      // lock cleared by an admin directly in Firestore (billingCreditLocked).
      if (data.billingCreditLocked === true) throw new Error("LOCKED");

      const newTotal = amount;
      const rate = Number(data.billingRatePerSms);

      const update: Record<string, unknown> = {
        billingCreditTotal: newTotal,
        billingCreditLocked: true,
      };
      if (!data.billingStartedAt) update.billingStartedAt = new Date();
      if (!Number.isFinite(rate) || rate <= 0) update.billingRatePerSms = DEFAULT_RATE;

      tx.set(userRef, update, { merge: true });
      tx.set(creditRef, {
        amount,
        note,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: decoded.uid,
      });
      return { creditTotal: newTotal };
    });

    return NextResponse.json({ ok: true, uid, amount, creditTotal: result.creditTotal });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    if (message === "LOCKED") return fail("Seek admin permission to add balance.", 409);
    if (message === "NOT_FOUND") return fail("Account not found.", 404);
    if (message === "SUPERADMIN") return fail("Superadmin accounts can't be recharged.", 400);
    console.error("Add credit failed", error);
    return fail(message, 500);
  }
}
