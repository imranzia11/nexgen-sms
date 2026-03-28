import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function normalizeKeyword(raw: string) {
  return String(raw || "").trim().toUpperCase();
}

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);

const START_KEYWORDS = new Set([
  "START",
  "UNSTOP",
  "YES",
]);

const HELP_KEYWORDS = new Set([
  "HELP",
  "INFO",
]);

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "twilio inbound route live",
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const fromRaw = String(formData.get("From") || "");
    const toRaw = String(formData.get("To") || "");
    const bodyRaw = String(formData.get("Body") || "");
    const messageSid = String(formData.get("MessageSid") || "");
    const messagingServiceSid = String(formData.get("MessagingServiceSid") || "");
    const accountSid = String(formData.get("AccountSid") || "");
    const optOutTypeRaw = String(formData.get("OptOutType") || "");

    const from = toE164(fromRaw);
    const to = toE164(toRaw);
    const body = String(bodyRaw || "").trim();
    const normalizedBody = normalizeKeyword(body);
    const optOutType = normalizeKeyword(optOutTypeRaw);

    let eventType = "MESSAGE";

    if (optOutType === "STOP" || STOP_KEYWORDS.has(normalizedBody)) {
      eventType = "STOP";
    } else if (optOutType === "START" || START_KEYWORDS.has(normalizedBody)) {
      eventType = "START";
    } else if (optOutType === "HELP" || HELP_KEYWORDS.has(normalizedBody)) {
      eventType = "HELP";
    }

    await adminDb.collection("replies").add({
      phone: from,
      to,
      body,
      normalizedBody,
      direction: "inbound",
      messageSid,
      messagingServiceSid,
      accountSid,
      optOutType: optOutType || null,
      eventType,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (from) {
      const blacklistRef = adminDb
        .collection("blacklisted_numbers")
        .doc(phoneDocId(from));

      const blacklistEventRef = adminDb.collection("blacklist_events").doc();

      if (eventType === "STOP") {
        await blacklistRef.set(
          {
            phone: from,
            status: "blocked",
            source: "twilio_inbound",
            reason: "user_opt_out",
            lastKeyword: optOutType || normalizedBody || "STOP",
            lastBody: body,
            lastMessageSid: messageSid || null,
            messagingServiceSid: messagingServiceSid || null,
            blockedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            unblockedAt: null,
          },
          { merge: true }
        );

        await blacklistEventRef.set({
          phone: from,
          eventType: "STOP",
          body,
          normalizedBody,
          messageSid: messageSid || null,
          messagingServiceSid: messagingServiceSid || null,
          createdAt: FieldValue.serverTimestamp(),
        });
      } else if (eventType === "START") {
        await blacklistRef.set(
          {
            phone: from,
            status: "active",
            source: "twilio_inbound",
            reason: "user_opt_in",
            lastKeyword: optOutType || normalizedBody || "START",
            lastBody: body,
            lastMessageSid: messageSid || null,
            messagingServiceSid: messagingServiceSid || null,
            unblockedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        await blacklistEventRef.set({
          phone: from,
          eventType: "START",
          body,
          normalizedBody,
          messageSid: messageSid || null,
          messagingServiceSid: messagingServiceSid || null,
          createdAt: FieldValue.serverTimestamp(),
        });
      } else if (eventType === "HELP") {
        await blacklistEventRef.set({
          phone: from,
          eventType: "HELP",
          body,
          normalizedBody,
          messageSid: messageSid || null,
          messagingServiceSid: messagingServiceSid || null,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    }

    return NextResponse.json({ ok: true, eventType });
  } catch (error: any) {
    console.error("Twilio inbound webhook error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Unknown error",
      },
      { status: 500 }
    );
  }
}