// Thin wrapper around SendGrid's Sender Identities REST API (POST/GET
// /v3/senders) - a different concern from lib/emailSend.ts (which sends
// mail through the @sendgrid/mail SDK). This module manages the sender
// identities themselves: creating one (which makes SendGrid fire off its
// own verification email automatically), checking whether it's been
// verified yet, and resending that verification email.
//
// Docs: https://www.twilio.com/docs/sendgrid/api-reference/sender-identities-api/create-a-sender-identity

const SENDGRID_API_BASE = "https://api.sendgrid.com/v3";

// Every Nexgen sender identity shares the same real business address -
// SendGrid requires a physical mailing address on every sender identity
// (CAN-SPAM requirement), it isn't something each rep should have to type
// in themselves.
const NEXGEN_SENDER_ADDRESS = {
  address: "3 Middle Country Rd Suite 3",
  city: "Coram",
  state: "NY",
  zip: "11727",
  country: "United States",
};

export type SenderIdentity = {
  id: number;
  nickname: string;
  from: { email: string; name: string };
  reply_to: { email: string; name: string };
  verified: boolean;
};

function ensureApiKey(): string {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SENDGRID_API_KEY configuration.");
  }
  return apiKey;
}

async function sendgridRequest(
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  const apiKey = ensureApiKey();

  const res = await fetch(`${SENDGRID_API_BASE}${path}`, {
    method: init.method || "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  // SendGrid returns 204 No Content for the resend-verification endpoint.
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      data?.errors?.[0]?.message || `SendGrid request failed (${res.status}).`;
    throw new Error(message);
  }

  return data;
}

export async function createSenderIdentity(opts: {
  email: string;
  name: string;
}): Promise<SenderIdentity> {
  const nickname = `${opts.name || opts.email} - ${Date.now()}`.slice(0, 100);

  return sendgridRequest("/senders", {
    method: "POST",
    body: {
      nickname,
      from: { email: opts.email, name: opts.name },
      reply_to: { email: opts.email, name: opts.name },
      ...NEXGEN_SENDER_ADDRESS,
    },
  }) as Promise<SenderIdentity>;
}

export async function getSenderIdentity(senderId: number): Promise<SenderIdentity> {
  return sendgridRequest(`/senders/${senderId}`) as Promise<SenderIdentity>;
}

export async function resendSenderVerification(senderId: number): Promise<void> {
  await sendgridRequest(`/senders/${senderId}/resend_verification`, {
    method: "POST",
  });
}
