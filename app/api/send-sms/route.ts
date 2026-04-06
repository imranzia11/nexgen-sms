import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { getAuth } from "firebase-admin/auth";
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

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

async function hasPreviouslySentSuccessfulSms(ownerUid: string, phone: string) {
  const snap = await adminDb
    .collection("messages")
    .where("ownerUid", "==", ownerUid)
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

function buildPersonalizedMessage(
  baseMessage: string,
  leadName?: string,
  isFirstMessage?: boolean
) {
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
    const decodedUser = await getUserFromRequest(req);
    const uid = decodedUser.uid;

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
        { ok: false, error: "User account is inactive." },
        { status: 403 }
      );
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

    const twilioNumber = toE164(
      String(userData.twilioNumber || userData.assignedTwilioNumber || "")
    );

    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio account configuration." },
        { status: 500 }
      );
    }

    if (!appBaseUrl) {
      return NextResponse.json(
        { ok: false, error: "APP_BASE_URL is missing." },
        { status: 500 }
      );
    }

    if (!twilioNumber) {
      return NextResponse.json(
        { ok: false, error: "No Twilio number is assigned to this user." },
        { status: 400 }
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
        const alreadyMessaged = await hasPreviouslySentSuccessfulSms(
          uid,
          formattedPhone
        );

        const isFirstMessage = !alreadyMessaged;
        const finalMessage = buildPersonalizedMessage(
          message.trim(),
          lead.name,
          isFirstMessage
        );

        const res = await client.messages.create({
          body: finalMessage,
          to: formattedPhone,
          from: twilioNumber,
          statusCallback: `${appBaseUrl}/api/send-sms/twilio/status`,
        });

        const convoId = `${uid}_${phoneDocId(formattedPhone)}`;
        const convoRef = adminDb.collection("conversations").doc(convoId);
        const threadMessageRef = convoRef.collection("messages").doc(res.sid);

        const existingConvoSnap = await convoRef.get();
        const existingConvo = existingConvoSnap.exists
          ? existingConvoSnap.data() || {}
          : {};

        const existingUnreadCount = Number(existingConvo.unreadCount || 0);
        const existingReplyCount = Number(existingConvo.replyCount || 0);
        const existingHasReply = existingConvo.hasReply === true;

        await threadMessageRef.set({
          sid: res.sid,
          ownerUid: uid,
          ownerEmail: String(userData.email || ""),
          ownerName: String(userData.name || ""),
          ownerRole: String(userData.role || "user"),
          conversationId: convoId,
          from: res.from || twilioNumber,
          to: formattedPhone,
          phone: formattedPhone,
          body: finalMessage,
          direction: "outbound",
          status: res.status || "queued",
          read: true,
          isFirstMessage,
          twilioNumber,
          assignedTwilioNumber: twilioNumber,
          messagingServiceSid: "",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        await convoRef.set(
          {
            ownerUid: uid,
            ownerEmail: String(userData.email || ""),
            ownerName: String(userData.name || ""),
            ownerRole: String(userData.role || "user"),
            phone: formattedPhone,
            name: formatLeadName(lead.name || ""),
            twilioNumber,
            assignedTwilioNumber: twilioNumber,
            messagingServiceSid: "",
            lastMessage: finalMessage,
            lastDirection: "outbound",
            lastMessageAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            status: existingHasReply ? "replied" : "awaiting_reply",
            hasReply: existingHasReply,
            unreadCount: existingUnreadCount,
            replyCount: existingReplyCount,
            outboundCount: FieldValue.increment(1),
            messageCount: FieldValue.increment(1),
            firstOutboundAt:
              existingConvo.firstOutboundAt || FieldValue.serverTimestamp(),
            lastOutboundAt: FieldValue.serverTimestamp(),
            lastInboundAt: existingConvo.lastInboundAt || null,
            lastOutboundStatus: res.status || "queued",
          },
          { merge: true }
        );

        await adminDb.collection("messages").add({
          ownerUid: uid,
          ownerEmail: String(userData.email || ""),
          ownerName: String(userData.name || ""),
          ownerRole: String(userData.role || "user"),
          conversationId: convoId,
          campaignName: campaignName || "",
          fileId: fileId || "",
          fileName: fileName || "",
          name: formatLeadName(lead.name || ""),
          phone: formattedPhone,
          to: formattedPhone,
          from: res.from || twilioNumber,
          body: finalMessage,
          sid: res.sid,
          twilioSid: res.sid,
          status: res.status || "queued",
          direction: "outbound",
          read: true,
          isFirstMessage,
          twilioNumber,
          assignedTwilioNumber: twilioNumber,
          messagingServiceSid: "",
          sourceFileName: fileName || "",
          error: "",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        results.push({
          name: lead.name,
          phone: formattedPhone,
          ok: true,
          sid: res.sid,
          status: res.status || "queued",
          personalizedBody: finalMessage,
          isFirstMessage,
        });
      } catch (err: any) {
        await adminDb.collection("messages").add({
          ownerUid: uid,
          ownerEmail: String(userData.email || ""),
          ownerName: String(userData.name || ""),
          ownerRole: String(userData.role || "user"),
          campaignName: campaignName || "",
          fileId: fileId || "",
          fileName: fileName || "",
          name: formatLeadName(lead.name || ""),
          phone: formattedPhone,
          to: formattedPhone,
          from: twilioNumber,
          body: message?.trim() || "",
          sid: "",
          twilioSid: "",
          status: "failed",
          direction: "outbound",
          isFirstMessage: false,
          twilioNumber,
          assignedTwilioNumber: twilioNumber,
          messagingServiceSid: "",
          sourceFileName: fileName || "",
          error: err?.message || "Failed to send",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

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