import sgMail from "@sendgrid/mail";

// Single choke point for every outbound email send in the app - same
// pattern as lib/twilioSend.ts for SMS. Every email route/script should
// call sendEmailForUser() rather than touching the SendGrid client
// directly, so the API key setup, error handling, and "from" resolution
// only ever live in one place.

export type SendEmailUserData = {
  senderEmail?: string;
  senderName?: string;
};

export type SendEmailResult = {
  messageId: string;
  status: "sent";
};

export class MissingSendGridConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSendGridConfigError";
  }
}

export class MissingSenderEmailError extends Error {
  constructor() {
    super("No verified sender email is set up for this user.");
    this.name = "MissingSenderEmailError";
  }
}

let apiKeyConfigured = false;

function ensureApiKey() {
  if (apiKeyConfigured) return;

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new MissingSendGridConfigError("Missing SENDGRID_API_KEY configuration.");
  }

  sgMail.setApiKey(apiKey);
  apiKeyConfigured = true;
}

export async function sendEmailForUser(opts: {
  userData: SendEmailUserData;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}): Promise<SendEmailResult> {
  ensureApiKey();

  const fromEmail = String(opts.userData.senderEmail || "").trim();
  if (!fromEmail) {
    throw new MissingSenderEmailError();
  }

  const to = String(opts.to || "").trim();
  const subject = String(opts.subject || "").trim();
  const html = opts.html?.trim();
  // SendGrid's types require `text` to be a definite string whenever it's
  // present at all (it can't be `string | undefined` alongside `html`), so
  // this always falls back to something real rather than leaving it
  // possibly undefined.
  const text = opts.text?.trim() || subject;

  const [response] = await sgMail.send({
    to,
    from: {
      email: fromEmail,
      name: opts.userData.senderName || undefined,
    },
    subject,
    text,
    ...(html ? { html } : {}),
  });

  return {
    messageId: String(response.headers["x-message-id"] || ""),
    status: "sent",
  };
}
