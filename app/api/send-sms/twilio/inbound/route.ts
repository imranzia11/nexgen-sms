import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { getDownloadURL } from "firebase-admin/storage";
import { adminDb, adminStorage } from "../../../../../lib/firebaseAdmin";
import { upsertGlobalBlocklist } from "../../../../../lib/globalBlocklist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function xmlResponse(message?: string) {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
        message
      )}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
      "Cache-Control": "no-store",
    },
  });
}

function escapeXml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toE164(raw: string) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  return `+${cleaned}`;
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function normalizeKeyword(value: string) {
  return String(value || "").trim().toUpperCase();
}

function normalizeInboundText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractInboundMedia(
  params: Record<string, string>
): Array<{ url: string; contentType: string }> {
  const count = Number(params.NumMedia || "0");
  if (!Number.isFinite(count) || count <= 0) return [];

  const media: Array<{ url: string; contentType: string }> = [];

  for (let i = 0; i < count; i += 1) {
    const url = String(params[`MediaUrl${i}`] || "").trim();
    const contentType = String(params[`MediaContentType${i}`] || "").trim();

    if (!url) continue;

    media.push({
      url,
      contentType,
    });
  }

  return media;
}

function getFileExtensionFromContentType(contentType: string) {
  const value = String(contentType || "").toLowerCase();

  if (value.includes("jpeg")) return "jpg";
  if (value.includes("jpg")) return "jpg";
  if (value.includes("png")) return "png";
  if (value.includes("gif")) return "gif";
  if (value.includes("webp")) return "webp";
  if (value.includes("mp4")) return "mp4";
  if (value.includes("quicktime")) return "mov";
  if (value.includes("mpeg")) return "mp3";
  if (value.includes("mp3")) return "mp3";
  if (value.includes("wav")) return "wav";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("pdf")) return "pdf";

  return "bin";
}

async function downloadAndStoreTwilioMedia(opts: {
  ownerUid: string;
  conversationId: string;
  messageSid: string;
  from: string;
  items: Array<{ url: string; contentType: string }>;
}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";

  if (!accountSid || !authToken || opts.items.length === 0) {
    return opts.items.map((item) => ({
      url: item.url,
      contentType: item.contentType,
      storagePath: "",
      source: "twilio",
    }));
  }

  const bucket = adminStorage.bucket();

  const uploaded = await Promise.all(
    opts.items.map(async (item, index) => {
      try {
        const res = await fetch(item.url, {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          },
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch media: ${res.status}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const ext = getFileExtensionFromContentType(item.contentType);
        const storagePath =
          `incoming_mms/${opts.ownerUid}/${opts.conversationId}/` +
          `${opts.messageSid}-${index + 1}.${ext}`;

        const file = bucket.file(storagePath);

        await file.save(buffer, {
          resumable: false,
          metadata: {
            contentType: item.contentType || "application/octet-stream",
            metadata: {
              ownerUid: opts.ownerUid,
              conversationId: opts.conversationId,
              messageSid: opts.messageSid,
              from: opts.from,
              originalTwilioUrl: item.url,
            },
          },
        });

        const publicUrl = await getDownloadURL(file);

        return {
          url: publicUrl,
          contentType: item.contentType,
          storagePath,
          source: "firebase_storage",
          originalUrl: item.url,
        };
      } catch (error) {
        console.error("Failed to mirror inbound media to Firebase Storage", {
          messageSid: opts.messageSid,
          url: item.url,
          error,
        });

        return {
          url: item.url,
          contentType: item.contentType,
          storagePath: "",
          source: "twilio",
          originalUrl: item.url,
        };
      }
    })
  );

  return uploaded;
}

const abusiveKeywords = [
  "fuck you",
  "fuck off",
  "motherfucker",
  "mother fucker",
  "piece of shit",
  "son of a bitch",
  "go to hell",
  "eat shit",
  "stupid bitch",
  "dumb bitch",
  "stupid asshole",
  "dumb asshole",
  "you asshole",
  "you idiot",
  "you moron",
  "you bastard",
  "fuck",
  "fucker",
  "bitch",
  "bastard",
  "asshole",
  "idiot",
  "moron",
  "scam",
  "scammer",
  "trash",
  "loser",
  "jerk",
  "dumb",
  "stupid",
  "clown",
  "garbage",
  "nonsense",
  "bullshit",
  "shithead",
  "dickhead",
  "retard",
  "screw you",
  "leave me the fuck alone",
  "stop texting me asshole",
  "stop texting me idiot",
  "go away idiot",
  "go away asshole",
];

function isAbusiveMessage(body: string) {
  const text = normalizeInboundText(body);
  return abusiveKeywords.some((item) => text.includes(item));
}

function buildConversationId(uid: string, customerPhone: string) {
  return `${uid}_${phoneDocId(customerPhone)}`;
}

async function findOwnerByTwilioNumber(inboundTo: string) {
  const normalizedTo = toE164(inboundTo);
  if (!normalizedTo) return null;

  // Fast path: numberAssignments/{e164} is a structural 1:1 mapping (doc ID
  // = the number) written at provisioning time via create-only semantics,
  // so it can never point at more than one user. Check it first.
  const assignmentSnap = await adminDb
    .collection("numberAssignments")
    .doc(normalizedTo)
    .get();

  if (assignmentSnap.exists) {
    const assignment = assignmentSnap.data() || {};
    const ownerUid = String(assignment.ownerUid || "");

    if (ownerUid) {
      const userDoc = await adminDb.collection("users").doc(ownerUid).get();

      if (userDoc.exists) {
        const data = userDoc.data() || {};
        if (data.isActive === true) {
          return {
            uid: userDoc.id,
            user: data,
            twilioNumber: normalizedTo,
          };
        }
      }
    }
  }

  // Fallback path for numbers not yet backfilled into numberAssignments:
  // the original where()-query lookup against the users collection.
  let snap = await adminDb
    .collection("users")
    .where("twilioNumber", "==", normalizedTo)
    .limit(1)
    .get();

  if (snap.empty) {
    snap = await adminDb
      .collection("users")
      .where("assignedTwilioNumber", "==", normalizedTo)
      .limit(1)
      .get();
  }

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data() || {};

  if (data.isActive !== true) return null;

  return {
    uid: doc.id,
    user: data,
    twilioNumber: normalizedTo,
  };
}

async function upsertBlacklist(opts: {
  ownerUid: string;
  phone: string;
  keyword: string;
  twilioNumber: string;
  messageSid: string;
  body?: string;
  source?: string;
}) {
  const {
    ownerUid,
    phone,
    keyword,
    twilioNumber,
    messageSid,
    body = "",
    source = "twilio_inbound",
  } = opts;

  const existing = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  const isStart = keyword === "START";
  const isStop = keyword === "STOP";
  const isAbuse = keyword === "ABUSE";

  const payload = {
    ownerUid,
    phone,
    twilioNumber,
    assignedTwilioNumber: twilioNumber,
    status: isStart ? "active" : "blocked",
    source,
    keyword,
    reason: isAbuse
      ? "abusive_language"
      : isStop
        ? "opt_out"
        : isStart
          ? "resubscribe"
          : "manual",
    lastBody: body,
    lastKeyword: keyword,
    lastMessageSid: messageSid,
    updatedAt: FieldValue.serverTimestamp(),
    blockedAt: !isStart ? FieldValue.serverTimestamp() : null,
    unblockedAt: isStart ? FieldValue.serverTimestamp() : null,
  };

  if (!existing.empty) {
    await existing.docs[0].ref.set(payload, { merge: true });
    return;
  }

  await adminDb.collection("blacklisted_numbers").add({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function getBlockedStatus(ownerUid: string, phone: string) {
  const snap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) return false;

  const data = snap.docs[0].data() || {};
  return String(data.status || "").toLowerCase() === "blocked";
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    );

    const signature = req.headers.get("x-twilio-signature") || "";
    const authToken = process.env.TWILIO_AUTH_TOKEN || "";
    const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

    const requestUrl = appBaseUrl
      ? `${appBaseUrl}/api/send-sms/twilio/inbound`
      : req.url;

    if (authToken && signature) {
      const isValid = twilio.validateRequest(
        authToken,
        signature,
        requestUrl,
        params
      );

      if (!isValid) {
        console.error("Invalid Twilio signature", {
          requestUrl,
          from: params.From,
          to: params.To,
          sid: params.MessageSid,
        });
        return new Response("Invalid signature", { status: 403 });
      }
    }

    const from = toE164(params.From || "");
    const to = toE164(params.To || "");
    const body = String(params.Body || "").trim();
    const messageSid = String(params.MessageSid || "").trim();
    const smsStatus = String(params.SmsStatus || "received").trim() || "received";
    const messagingServiceSid = String(params.MessagingServiceSid || "").trim();
    const inboundMedia = extractInboundMedia(params);

    if (!from || !to || !messageSid) {
      console.error("Inbound webhook missing required fields", {
        from,
        to,
        messageSid,
      });
      return xmlResponse();
    }

    const owner = await findOwnerByTwilioNumber(to);

    if (!owner) {
      console.error("No active user found for inbound Twilio number", {
        to,
        from,
        messageSid,
      });
      return xmlResponse();
    }

    const { uid, user, twilioNumber } = owner;
    const conversationId = buildConversationId(uid, from);

    const mirroredMedia = await downloadAndStoreTwilioMedia({
      ownerUid: uid,
      conversationId,
      messageSid,
      from,
      items: inboundMedia,
    });

    const mediaUrls = mirroredMedia.map((item) => item.url).filter(Boolean);
    const numMedia = mediaUrls.length;

    const convoRef = adminDb.collection("conversations").doc(conversationId);
    const threadMessageRef = convoRef.collection("messages").doc(messageSid);
    const replyRef = adminDb.collection("replies").doc(messageSid);

    const [convoSnap, existingThreadMsgSnap, existingReplySnap] =
      await Promise.all([convoRef.get(), threadMessageRef.get(), replyRef.get()]);

    const existingConvo = convoSnap.exists ? convoSnap.data() || {} : {};
    const existingName = String(existingConvo.name || "").trim();

    const keyword = normalizeKeyword(body);
    const isStop = keyword === "STOP";
    const isStart = keyword === "START";
    const isHelp = keyword === "HELP";
    const isAbuse = isAbusiveMessage(body);

    if (isStop || isStart || isAbuse) {
      await upsertBlacklist({
        ownerUid: uid,
        phone: from,
        keyword: isAbuse ? "ABUSE" : keyword,
        twilioNumber,
        messageSid,
        body,
        source: isAbuse ? "inbound_auto_block" : "twilio_inbound",
      });

      // Compliance requirement: an opt-out (or auto-detected abuse) must
      // stop ALL users from messaging this number, not just the one whose
      // number the customer happened to reply to. blacklisted_numbers
      // above is scoped per-owner; this is the platform-wide backstop,
      // checked inside sendSmsForUser on every single send path.
      await upsertGlobalBlocklist({
        phone: from,
        keyword: isAbuse ? "ABUSE" : keyword,
        triggeredByUid: uid,
        triggeredByTwilioNumber: twilioNumber,
        messageSid,
        body,
      });
    }

    const blockedNow = await getBlockedStatus(uid, from);
    const shouldBeBlockedAfterThisMessage = isStop
      ? true
      : isStart
        ? false
        : isAbuse
          ? true
          : blockedNow;

    const storedKeyword = isStop || isStart || isHelp ? keyword : isAbuse ? "ABUSE" : "";
    const previewText = body || (numMedia > 0 ? "Sent media" : "");

    const inboundMessageData = {
      sid: messageSid,
      twilioSid: messageSid,
      ownerUid: uid,
      ownerEmail: String(user.email || ""),
      ownerName: String(user.name || ""),
      ownerRole: String(user.role || "user"),
      conversationId,
      from,
      to: twilioNumber,
      phone: from,
      body,
      mediaUrls,
      mediaMeta: mirroredMedia,
      numMedia,
      direction: "inbound",
      status: smsStatus,
      read: false,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      keyword: storedKeyword,
      blockedAfterMessage: shouldBeBlockedAfterThisMessage,
      createdAt: existingThreadMsgSnap.exists
        ? existingThreadMsgSnap.data()?.createdAt || FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const replyData = {
      ownerUid: uid,
      ownerEmail: String(user.email || ""),
      ownerName: String(user.name || ""),
      ownerRole: String(user.role || "user"),
      conversationId,
      name: existingName,
      phone: from,
      from,
      to: twilioNumber,
      body,
      mediaUrls,
      mediaMeta: mirroredMedia,
      numMedia,
      sid: messageSid,
      twilioSid: messageSid,
      status: smsStatus,
      direction: "inbound",
      read: false,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      keyword: storedKeyword,
      blockedAfterMessage: shouldBeBlockedAfterThisMessage,
      createdAt: existingReplySnap.exists
        ? existingReplySnap.data()?.createdAt || FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const convoUpdate: Record<string, unknown> = {
      ownerUid: uid,
      ownerEmail: String(user.email || ""),
      ownerName: String(user.name || ""),
      ownerRole: String(user.role || "user"),
      phone: from,
      name: existingName,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      lastMessage: previewText,
      lastDirection: "inbound",
      lastMessageAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      status: "replied",
      hasReply: true,
      lastInboundAt: FieldValue.serverTimestamp(),
      lastInboundSid: messageSid,
      blocked: shouldBeBlockedAfterThisMessage,
      blockedAt:
        isStop || isAbuse
          ? FieldValue.serverTimestamp()
          : existingConvo.blockedAt || null,
      unblockedAt: isStart
        ? FieldValue.serverTimestamp()
        : existingConvo.unblockedAt || null,
    };

    const isFirstInboundWrite = !existingThreadMsgSnap.exists;

    if (isFirstInboundWrite) {
      convoUpdate.unreadCount = FieldValue.increment(1);
      convoUpdate.replyCount = FieldValue.increment(1);
      convoUpdate.inboundCount = FieldValue.increment(1);
      convoUpdate.messageCount = FieldValue.increment(1);
    }

    const batch = adminDb.batch();

    batch.set(threadMessageRef, inboundMessageData, { merge: true });
    batch.set(replyRef, replyData, { merge: true });
    batch.set(convoRef, convoUpdate, { merge: true });

    await batch.commit();

    if (isStop) {
      return xmlResponse(
        "You have successfully opted out. You will not receive further messages."
      );
    }

    if (isStart) {
      return xmlResponse(
        "You have been re-subscribed and can receive messages again."
      );
    }

    if (isHelp) {
      return xmlResponse(
        "Reply STOP to unsubscribe. Reply START to re-subscribe."
      );
    }

    if (isAbuse) {
      return xmlResponse("Your number has been removed from future messages.");
    }

    return xmlResponse();
  } catch (err: any) {
    console.error("Inbound Twilio webhook error", err);
    return xmlResponse();
  }
}