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
