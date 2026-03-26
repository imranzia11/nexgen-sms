import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";

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
        const res = await client.messages.create({
          body: message.trim(),
          to: formattedPhone,
          messagingServiceSid,
        });

        results.push({
          name: lead.name,
          phone: formattedPhone,
          ok: true,
          sid: res.sid,
          status: res.status,
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