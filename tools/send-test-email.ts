// One-off sanity check for the SendGrid setup - sends a single test email
// so we can confirm the API key + verified sender actually work end-to-end
// before any real UI is built on top of it.
//
// Usage:
//   npx tsx tools/send-test-email.ts --from=you@yourdomain.com --to=you@yourdomain.com

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const fromArg = process.argv.find((a) => a.startsWith("--from="));
  const toArg = process.argv.find((a) => a.startsWith("--to="));

  const from = fromArg ? fromArg.split("=")[1].trim() : "";
  const to = toArg ? toArg.split("=")[1].trim() : "";

  if (!from || !to) {
    console.error("Usage: npx tsx tools/send-test-email.ts --from=you@yourdomain.com --to=you@yourdomain.com");
    process.exit(1);
  }

  const { sendEmailForUser } = await import("../lib/emailSend");

  console.log(`Sending a test email from ${from} to ${to}...`);

  const result = await sendEmailForUser({
    userData: { senderEmail: from, senderName: "Nexgen Admin Test" },
    to,
    subject: "Nexgen Admin - SendGrid test",
    html: "<p>This is a test email confirming the SendGrid integration is working.</p>",
  });

  console.log("Sent:", result);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Send failed:", e?.response?.body || e);
    process.exit(1);
  });
