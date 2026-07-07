import twilio from "twilio";
import { toE164 } from "./phone";
import { assertNotGloballyBlocked, BlockedNumberError } from "./globalBlocklist";

export { BlockedNumberError };

// Single choke point for every outbound Twilio send in the app.
//
// Why this exists: send-reply, send-sms, send-sms/twilio, and
// cron/send-followups each used to build their own Twilio payload inline.
// Every one of them sent via `messagingServiceSid` alone, with no `from`.
// Twilio's Messaging Service is then free to pick ANY number in its sender
// pool to actually deliver the message — and since multiple users' numbers
// live in the same shared Messaging Service, that meant a message sent by
// user A could go out from user B's number. When the customer replied, the
// inbound webhook (correctly) attributed it to whoever owns the number the
// reply landed on — user B — not the user who actually started the
// conversation. That's the cross-account leak.
//
// The fix is to always pin `from` to the sending user's own dedicated
// number. Routing every send through this one function means that
// guarantee can't be silently dropped by a new call site in the future.

export type SendSmsUserData = {
  twilioNumber?: string;
  assignedTwilioNumber?: string;
  messagingServiceSid?: string;
};

export type SendSmsResult = {
  sid: string;
  status: string;
  from: string;
};

export class MissingTwilioNumberError extends Error {
  constructor() {
    super("No Twilio number is assigned to this user.");
    this.name = "MissingTwilioNumberError";
  }
}

export class MissingTwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTwilioConfigError";
  }
}

function resolveTwilioNumber(userData: SendSmsUserData) {
  return toE164(String(userData.twilioNumber || userData.assignedTwilioNumber || ""));
}

export function getUserTwilioNumber(userData: SendSmsUserData) {
  return resolveTwilioNumber(userData);
}

export async function sendSmsForUser(opts: {
  userData: SendSmsUserData;
  to: string;
  body?: string;
  mediaUrls?: string[];
  statusCallbackPath?: string;
}): Promise<SendSmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

  if (!accountSid || !authToken) {
    throw new MissingTwilioConfigError("Missing Twilio account configuration.");
  }

  const twilioNumber = resolveTwilioNumber(opts.userData);
  if (!twilioNumber) {
    throw new MissingTwilioNumberError();
  }

  const messagingServiceSid = String(
    opts.userData.messagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID || ""
  ).trim();

  const to = toE164(opts.to);
  const body = String(opts.body || "").trim();
  const mediaUrl = (opts.mediaUrls || []).filter(Boolean);

  // Platform-wide opt-out check. This runs regardless of whether the
  // calling route did its own per-owner blacklist check (one of them,
  // send-sms/twilio/route.ts, never did) — so this is the one place a
  // STOP can never be bypassed by any current or future send path.
  await assertNotGloballyBlocked(to);

  const client = twilio(accountSid, authToken);

  const payload: {
    to: string;
    from: string;
    messagingServiceSid?: string;
    statusCallback?: string;
    body?: string;
    mediaUrl?: string[];
  } = {
    to,
    // This is the actual fix: pin the literal sender number so Twilio's
    // Messaging Service pool can never substitute a different user's
    // number for this send.
    from: twilioNumber,
  };

  if (messagingServiceSid) {
    payload.messagingServiceSid = messagingServiceSid;
  }

  if (appBaseUrl) {
    payload.statusCallback = `${appBaseUrl}${
      opts.statusCallbackPath || "/api/send-sms/twilio/status"
    }`;
  }

  if (body) {
    payload.body = body;
  }

  if (mediaUrl.length > 0) {
    payload.mediaUrl = mediaUrl;
  }

  const msg = await client.messages.create(payload);

  return {
    sid: msg.sid,
    status: msg.status || "queued",
    from: msg.from || twilioNumber,
  };
}
