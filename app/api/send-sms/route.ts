import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";

type LeadInput = {
  name?: string;
  phone?: string;
};

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function formatLeadName(name?: string) {
  const value = String(name || "").trim();
  if (!value) return "";

  return value
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

async function hasPreviouslySentSuccessfulSms(phone: string) {
  const snap = await adminDb
    .collection("messages")
    .where("to", "==", phone)
    .where("direction", "==", "outbound")
    .limit(1)
    .get();

  if (snap.empty) return false;

  const successfulStatuses = new Set([
    "queued",
    "accepted",
    "scheduled",
    "sending",
    "sent",
    "delivered",
  ]);

  return snap.docs.some((doc) => {
    const data = doc.data();
    const status = String(data.status || "").toLowerCase();
    return successfulStatuses.has(status);
  });
}

function buildPersonalizedMessage(baseMessage: string, leadName?: string, isFirstMessage?: boolean) {
  const trimmedBase = String(baseMessage || "").trim();
  if (!trimmedBase) return "";

  if (!isFirstMessage) {
    return trimmedBase;
  }

  const cleanName = formatLeadName(leadName);
  const greeting = cleanName ? `Hi ${cleanName}! ` : "Hi! ";
  return `${greeting}${trimmedBase}`;
}

export async function POST(req: NextRequest) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!accountSid || !authToken || !messagingServiceSid) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio environment variables." },
        { status: 500 }
      );
    }

    const client = twilio(accountSid, authToken);

    const body = await req.json();

    const {
      campaignName,
      fileId,
      fileName,
      message,
      leads,
    }: {
      campaignName?: string;
      fileId?: string;
      fileName?: string;
      message?: string;
      leads?: LeadInput[];
    } = body;

    if (!message?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Message is required." },
        { status: 400 }
      );
    }

    if (!Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No leads provided." },
        { status: 400 }
      );
    }

    const results: Array<{
      name?: string;
      phone: string;
      ok: boolean;
      sid?: string;
      status?: string;
      error?: string;
      code?: number | null;
      personalizedBody?: string;
      isFirstMessage?: boolean;
    }> = [];

    for (const lead of leads) {
      const formattedPhone = toE164(lead.phone || "");

      if (!formattedPhone) {
        results.push({
          name: lead.name,
          phone: lead.phone || "",
          ok: false,
          error: "Invalid phone number",
          code: null,
        });
        continue;
      }

      try {
        const alreadyMessaged = await hasPreviouslySentSuccessfulSms(formattedPhone);
        const isFirstMessage = !alreadyMessaged;
        const finalMessage = buildPersonalizedMessage(
          message.trim(),
          lead.name,
          isFirstMessage
        );

        const res = await client.messages.create({
          body: finalMessage,
          to: formattedPhone,
          messagingServiceSid,
        });

        const convoId = phoneDocId(formattedPhone);
        const convoRef = adminDb.collection("conversations").doc(convoId);
        const threadMessageRef = convoRef.collection("messages").doc(res.sid);

        await threadMessageRef.set({
          sid: res.sid,
          from: res.from || "",
          to: formattedPhone,
          body: finalMessage,
          direction: "outbound",
          status: res.status || "sent",
          read: true,
          isFirstMessage,
          createdAt: FieldValue.serverTimestamp(),
        });

        await convoRef.set(
          {
            phone: formattedPhone,
            name: lead.name || "",
            lastMessage: finalMessage,
            lastDirection: "outbound",
            lastMessageAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        await adminDb.collection("messages").add({
          campaignName: campaignName || "",
          fileId: fileId || "",
          fileName: fileName || "",
          name: lead.name || "",
          to: formattedPhone,
          body: finalMessage,
          sid: res.sid,
          status: res.status || "sent",
          direction: "outbound",
          isFirstMessage,
          createdAt: FieldValue.serverTimestamp(),
        });

        results.push({
          name: lead.name,
          phone: formattedPhone,
          ok: true,
          sid: res.sid,
          status: res.status,
          personalizedBody: finalMessage,
          isFirstMessage,
        });
      } catch (err: any) {
        results.push({
          name: lead.name,
          phone: formattedPhone,
          ok: false,
          error: err?.message || "Failed to send",
          code: err?.code || null,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      campaignName: campaignName || "",
      fileId: fileId || "",
      fileName: fileName || "",
      total: results.length,
      success: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Unexpected server error",
      },
      { status: 500 }
    );
  }
}