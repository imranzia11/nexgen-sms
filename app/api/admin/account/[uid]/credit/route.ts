import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";

// Superadmin-only: add prepaid credit to one account.
//
// Each recharge is a ledger entry in users/{uid}/billingCredits and bumps the
// running total on the user doc (billingCreditTotal), in one transaction. The
// first recharge also starts metering: it sets billingStartedAt (usage is
// counted from then on) and a default per-SMS rate if none is set yet.
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

      const prevTotal = Number(data.billingCreditTotal) || 0;
      const newTotal = Math.round((prevTotal + amount) * 100) / 100;
      const rate = Number(data.billingRatePerSms);

      const update: Record<string, unknown> = { billingCreditTotal: newTotal };
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
    if (message === "NOT_FOUND") return fail("Account not found.", 404);
    if (message === "SUPERADMIN") return fail("Superadmin accounts can't be recharged.", 400);
    console.error("Add credit failed", error);
    return fail(message, 500);
  }
}
