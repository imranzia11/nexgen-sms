// Shared phone-number helpers. Previously this exact function was copy-pasted
// into send-reply, send-sms, send-sms/twilio, and cron/send-followups — kept
// here once so every call site normalizes numbers identically.

export function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

export function phoneDocId(phone: string) {
  return toE164(phone).replace(/[^\d+]/g, "");
}

// Reversed copy of a phone number, written alongside `phone` on every
// conversation doc so a Firestore range/prefix query can match the END of
// a number (e.g. "last 4 digits: 2955") as fast and indexed as matching
// the start already is. "+12073142955" reversed is "5592413702+1" -
// searching digits "2955" reversed is "5592", and a prefix query for
// "5592" against phoneReversed correctly finds it. Only ever needs to be
// computed at write time, from whatever the already-formatted `phone`
// value is - never derived from raw user input directly.
export function reversePhone(phone: string): string {
  return String(phone || "").split("").reverse().join("");
}
