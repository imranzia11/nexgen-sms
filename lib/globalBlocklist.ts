import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { toE164 } from "./phone";

// Platform-wide opt-out enforcement.
//
// blacklisted_numbers is scoped per-owner (ownerUid + phone), which means a
// STOP reply to one user's number only blocked that one user from texting
// the customer again — any other user whose lead list also contained that
// number could still message them. For TCPA/CTIA compliance, an opt-out
// needs to be honored by the whole operation, not just the specific rep the
// customer happened to reply to. globalBlacklist/{e164} is the backstop:
// checked inside sendSmsForUser (lib/twilioSend.ts), the single choke point
// every send path routes through, so it can't be bypassed by a route that
// forgets its own per-owner check (send-sms/twilio/route.ts, for example,
// never had one at all).

export class BlockedNumberError extends Error {
  constructor(phone: string) {
    super(`${phone} has opted out and cannot be messaged until they text START.`);
    this.name = "BlockedNumberError";
  }
}

export async function isGloballyBlocked(phone: string): Promise<boolean> {
  const normalized = toE164(phone);
  if (!normalized) return false;

  const doc = await adminDb.collection("globalBlacklist").doc(normalized).get();
  if (!doc.exists) return false;

  return String(doc.data()?.status || "").toLowerCase() === "blocked";
}

export async function assertNotGloballyBlocked(phone: string): Promise<void> {
  if (await isGloballyBlocked(phone)) {
    throw new BlockedNumberError(toE164(phone));
  }
}

// Called from the inbound webhook whenever a STOP, START, or auto-detected
// abuse keyword comes in on ANY user's number. Unlike blacklisted_numbers,
// this collection has no ownerUid — a block here applies to every user.
export async function upsertGlobalBlocklist(opts: {
  phone: string;
  keyword: string; // "STOP" | "START" | "ABUSE"
  triggeredByUid: string;
  triggeredByTwilioNumber: string;
  messageSid: string;
  body?: string;
}) {
  const normalized = toE164(opts.phone);
  if (!normalized) return;

  const isStart = opts.keyword === "START";
  const ref = adminDb.collection("globalBlacklist").doc(normalized);

  await ref.set(
    {
      phone: normalized,
      status: isStart ? "active" : "blocked",
      lastKeyword: opts.keyword,
      lastTriggeredByUid: opts.triggeredByUid,
      lastTriggeredByTwilioNumber: opts.triggeredByTwilioNumber,
      lastMessageSid: opts.messageSid,
      lastBody: opts.body || "",
      blockedAt: !isStart ? FieldValue.serverTimestamp() : null,
      unblockedAt: isStart ? FieldValue.serverTimestamp() : null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}
