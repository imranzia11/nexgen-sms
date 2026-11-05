import { adminDb } from "./firebaseAdmin";

// Prepaid accounts are metered from `billingStartedAt`; allowance is the sum
// of superadmin-added credit (`billingCreditTotal`) and usage is every SMS
// sent or received since then at `billingRatePerSms`. Accounts without
// `billingStartedAt` are not prepaid and are never gated here.
//
// Bulk sends call the send routes once per chunk, so the computed result is
// cached briefly per uid to keep the check cheap; the cache is dropped as
// soon as a gate trips so a recharge takes effect on the next attempt.

export const CAPACITY_BLOCK_MESSAGE =
  "Action blocked - CI/CD Runner Infrastructure is exhausted. Please try again later.";

type UserData = Record<string, any>;

const CACHE_MS = 20_000;
const cache = new Map<string, { at: number; creditTotal: number; blocked: boolean }>();

function isFailedStatus(status: unknown) {
  const value = String(status || "").trim().toLowerCase();
  return value === "failed" || value === "undelivered" || value === "canceled";
}

const userCache = new Map<string, { at: number; data: UserData }>();

// Same check for callers that only have a uid (the follow-up cron).
export async function isUidOutOfPrepaidBalance(uid: string): Promise<boolean> {
  if (!uid) return false;
  let entry = userCache.get(uid);
  if (!entry || Date.now() - entry.at >= CACHE_MS) {
    const snap = await adminDb.collection("users").doc(uid).get();
    entry = { at: Date.now(), data: snap.exists ? snap.data() || {} : {} };
    userCache.set(uid, entry);
  }
  return isOutOfPrepaidBalance(uid, entry.data);
}

// True when this account is prepaid and has no balance left.
export async function isOutOfPrepaidBalance(
  uid: string,
  userData: UserData
): Promise<boolean> {
  const started =
    userData.billingStartedAt && typeof userData.billingStartedAt.toDate === "function"
      ? (userData.billingStartedAt.toDate() as Date)
      : null;
  if (!started) return false;

  const creditTotal = Number(userData.billingCreditTotal) || 0;
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS && hit.creditTotal === creditTotal) {
    return hit.blocked;
  }

  const rate = Number(userData.billingRatePerSms);
  if (!Number.isFinite(rate) || rate <= 0) return false;

  const now = new Date();
  const [out, follow, inbound] = await Promise.all([
    adminDb
      .collection("messages")
      .where("ownerUid", "==", uid)
      .where("createdAt", ">=", started)
      .where("createdAt", "<=", now)
      .select("direction", "status")
      .get(),
    adminDb
      .collection("followUps")
      .where("ownerUid", "==", uid)
      .where("sentAt", ">=", started)
      .where("sentAt", "<=", now)
      .select("status")
      .get(),
    adminDb
      .collection("replies")
      .where("ownerUid", "==", uid)
      .where("createdAt", ">=", started)
      .where("createdAt", "<=", now)
      .select()
      .get(),
  ]);

  let count = inbound.size;
  out.docs.forEach((d) => {
    const data = d.data();
    if (data.direction === "outbound" && !isFailedStatus(data.status)) count += 1;
  });
  follow.docs.forEach((d) => {
    if (String(d.data().status || "").toLowerCase() === "sent") count += 1;
  });

  const blocked = creditTotal - count * rate <= 0;
  cache.set(uid, { at: Date.now(), creditTotal, blocked });
  return blocked;
}
