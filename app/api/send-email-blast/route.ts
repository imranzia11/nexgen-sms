import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";
import {
  sendEmailForUser,
  MissingSenderEmailError,
  MissingSendGridConfigError,
} from "../../../lib/emailSend";

// Mirrors app/api/send-sms/route.ts's "from" pattern: the sending identity
// (senderEmail/senderName) is always read server-side from the caller's own
// user doc, never trusted from the request body. That's what makes it safe
// to centralize through lib/emailSend.ts - a client can never impersonate
// another account's sender identity by tampering with the request.

type Recipient = {
  name?: string;
  email: string;
};

const MAX_RECIPIENTS_PER_REQUEST = 150; // same chunk size convention as SEND_CHUNK_SIZE in app/dashboard/page.tsx

function getBearerToken(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}

function isValidEmail(value: string): boolean {
  // Deliberately simple - good enough to catch obvious junk in an uploaded
  // CSV without rejecting valid-but-unusual addresses. SendGrid itself is
  // the real validator at send time.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export async function POST(req: NextRequest) {
  let uid: string | undefined;

  try {
    const token = getBearerToken(req);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing authorization token." },
        { status: 401 }
      );
    }

    const decodedUser = await getAuth().verifyIdToken(token);
    uid = decodedUser.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json(
        { ok: false, error: "User profile not found." },
        { status: 404 }
      );
    }

    const userData = userSnap.data() || {};

    if (userData.isActive !== true) {
      return NextResponse.json(
        { ok: false, error: "This account is not active." },
        { status: 403 }
      );
    }

    const senderEmail = String(userData.senderEmail || "").trim();
    if (!senderEmail) {
      return NextResponse.json(
        {
          ok: false,
          error: "No sending email is set up for this account.",
        },
        { status: 403 }
      );
    }

    const body = await req.json();
    const {
      campaignName,
      subject,
      html,
      text,
      recipients,
    }: {
      campaignName?: string;
      subject?: string;
      html?: string;
      text?: string;
      recipients?: Recipient[];
    } = body;

    if (!subject?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Subject is required." },
        { status: 400 }
      );
    }

    if (!text?.trim() && !html?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Email body is required." },
        { status: 400 }
      );
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No recipients provided." },
        { status: 400 }
      );
    }

    if (recipients.length > MAX_RECIPIENTS_PER_REQUEST) {
      return NextResponse.json(
        {
          ok: false,
          error: `Send at most ${MAX_RECIPIENTS_PER_REQUEST} recipients per request - the page splits larger lists into batches automatically.`,
        },
        { status: 400 }
      );
    }

    // Dedupe by email within this batch - a messy CSV can easily contain the
    // same address twice (different casing, duplicate rows, etc.).
    const seenEmails = new Set<string>();
    const results: { name?: string; email: string; status: "sent" | "failed"; error?: string }[] = [];

    let sentCount = 0;
    let failedCount = 0;
    let skippedDuplicates = 0;
    let skippedInvalid = 0;

    for (const recipient of recipients) {
      const email = String(recipient?.email || "").trim();
      const name = String(recipient?.name || "").trim();

      if (!email || !isValidEmail(email)) {
        skippedInvalid++;
        continue;
      }

      const emailKey = email.toLowerCase();
      if (seenEmails.has(emailKey)) {
        skippedDuplicates++;
        continue;
      }
      seenEmails.add(emailKey);

      // Every send is personalized with a "Hello {Name}," greeting pulled
      // from the lead's Name column - falls back to a plain "Hello," when
      // the CSV didn't have a name for that row. Done per-recipient here
      // (not once for the whole chunk) since each lead gets their own name.
      const greetingName = name || "";
      const greeting = greetingName ? `Hello ${greetingName},` : "Hello,";
      const personalizedText = text?.trim()
        ? `${greeting}\n\n${text.trim()}`
        : undefined;
      const personalizedHtml = html?.trim()
        ? `<p>${greeting}</p>${html.trim()}`
        : undefined;

      try {
        await sendEmailForUser({
          userData: { senderEmail, senderName: userData.senderName || "" },
          to: email,
          subject: subject.trim(),
          html: personalizedHtml,
          text: personalizedText,
        });
        results.push({ name, email, status: "sent" });
        sentCount++;
      } catch (sendErr: any) {
        results.push({
          name,
          email,
          status: "failed",
          error: sendErr?.message || "Send failed.",
        });
        failedCount++;
      }
    }

    // Best-effort audit trail via the admin SDK (bypasses Firestore rules
    // entirely, same as followUps/schedule-follow-up - no client-side rule
    // changes needed for this collection).
    try {
      await adminDb.collection("emailCampaigns").add({
        ownerUid: uid,
        senderEmail,
        senderName: userData.senderName || "",
        campaignName: campaignName || "",
        subject: subject.trim(),
        totalRecipients: recipients.length,
        sentCount,
        failedCount,
        skippedDuplicates,
        skippedInvalid,
        results,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (logError) {
      console.error("send-email-blast: failed to write campaign log (non-fatal)", logError);
    }

    return NextResponse.json({
      ok: true,
      sentCount,
      failedCount,
      skippedDuplicates,
      skippedInvalid,
      results,
    });
  } catch (err: any) {
    let status = 500;
    if (err instanceof MissingSenderEmailError) status = 403;
    if (err instanceof MissingSendGridConfigError) status = 500;

    console.error("send-email-blast failed", { uid, error: err?.message || err });

    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to send email blast." },
      { status }
    );
  }
}
