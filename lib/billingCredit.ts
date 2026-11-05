import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";

// Sets an account's prepaid credit once and locks it. Used by both the
// superadmin route and the account's own Billing page, so the rules can't
// drift apart:
//  - the amount SETS the credit total (it doesn't add to a previous one)
//  - it starts metering (billingStartedAt) and a default rate if none is set
//  - afterwards billingCreditLocked is true and further changes are refused
//    until an admin clears the lock directly in Firestore
//  - every entry is recorded in users/{uid}/billingCredits

export const DEFAULT_RATE = 0.3;
export const DEFAULT_SELF_CREDIT_MAX = 500;
export const LOCKED_MESSAGE = "Seek admin permission to add balance.";

export class CreditError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CreditError";
    this.status = status;
  }
}

export async function setPrepaidCredit(opts: {
  uid: string;
  amount: number;
  actorUid: string;
  // For self-service: refuse amounts above this.
  maxAmount?: number;
  source: "admin" | "self";
}): Promise<{ creditTotal: number }> {
  const amount = Math.round(Number(opts.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CreditError("Enter an amount greater than 0.", 400);
  }
  if (opts.maxAmount !== undefined && amount > opts.maxAmount) {
    throw new CreditError(
      `Amount can't exceed $${opts.maxAmount.toLocaleString("en-US")}.`,
      400
    );
  }
  if (amount > 100000) {
    throw new CreditError("Amount can't exceed $100,000.", 400);
  }

  const userRef = adminDb.collection("users").doc(opts.uid);
  const creditRef = userRef.collection("billingCredits").doc();

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new CreditError("Account not found.", 404);

    const data = snap.data() || {};
    if (String(data.role || "").toLowerCase() === "superadmin") {
      throw new CreditError("Superadmin accounts can't be funded.", 400);
    }
    if (data.billingCreditLocked === true) {
      throw new CreditError(LOCKED_MESSAGE, 409);
    }

    const rate = Number(data.billingRatePerSms);
    const update: Record<string, unknown> = {
      billingCreditTotal: amount,
      billingCreditLocked: true,
    };
    if (!data.billingStartedAt) update.billingStartedAt = new Date();
    if (!Number.isFinite(rate) || rate <= 0) update.billingRatePerSms = DEFAULT_RATE;

    tx.set(userRef, update, { merge: true });
    tx.set(creditRef, {
      amount,
      note: opts.source === "self" ? "Set by account" : "Set by admin",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: opts.actorUid,
    });
    return { creditTotal: amount };
  });
}
