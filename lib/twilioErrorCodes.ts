// Twilio's status-callback webhook only ever sends a numeric ErrorCode —
// never a human-readable description (that only comes back later, e.g. in
// the Twilio Console UI, or via a separate API fetch of the message
// resource). Without this table, the app had nothing to show except the
// bare code, which meant "30003: 30003" instead of an actual explanation.
// This is a lookup done at DISPLAY time, not at write time — so it applies
// to every message ever stored, past and future, with no backfill needed.
const TWILIO_ERROR_DESCRIPTIONS: Record<string, string> = {
  "30001": "Message queue overflow — Twilio couldn't queue this message for delivery.",
  "30002": "Account suspended by Twilio.",
  "30003": "The destination handset you are trying to reach is switched off or otherwise unavailable.",
  "30004": "This message was blocked by the recipient's carrier or by the recipient themselves.",
  "30005": "Unknown destination handset — this number may no longer be in service.",
  "30006": "This is a landline or otherwise unreachable number and cannot receive SMS.",
  "30007": "This message was filtered as spam by the carrier.",
  "30008": "Unknown error while attempting delivery.",
  "30009": "Message delivery failed — missing required segment.",
  "30010": "Message price exceeded the maximum price allowed.",
  "21211": "Invalid destination phone number.",
  "21608": "This number is unverified and cannot receive messages from a trial account.",
  "21610": "This recipient has unsubscribed (replied STOP) and cannot be messaged.",
  "21614": "This is not a valid mobile number.",
  "21617": "Message body exceeded the maximum allowed size.",
  "21619": "Attached media exceeded the maximum allowed size.",
};

export function describeTwilioError(errorCode?: string, rawError?: string): string {
  const code = String(errorCode || "").trim();
  const known = code ? TWILIO_ERROR_DESCRIPTIONS[code] : undefined;

  if (known) {
    return `${code}: ${known}`;
  }

  const raw = String(rawError || "").trim();

  // If the stored "error" text is just the same numeric code repeated
  // (no real message was ever provided), don't show "30003: 30003".
  if (raw && raw !== code) {
    return code ? `${code}: ${raw}` : raw;
  }

  if (code) {
    return `Delivery failed (Twilio error ${code}).`;
  }

  return "Delivery failed.";
}
