import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../lib/firebaseAdmin";
import { sendSmsForUser, BlockedNumberError } from "../../../lib/twilioSend";
import { toE164, phoneDocId } from "../../../lib/phone";

function normalizeMediaUrls(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((url) => /^https:\/\//i.test(url));
}

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  const decoded = await getAuth().verifyIdToken(token);
  return decoded;
}

async function isBlockedNumber(ownerUid: string, phone: string) {
  const snap = await adminDb
    .collection("blacklisted_numbers")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) return false;

  return snap.docs.some((doc) => {
    const data = doc.data() || {};
    return String(data.status || "").toLowerCase() === "blocked";
  });
}

export async function POST(req: NextRequest) {
  // Declared outside the try block (rather than as `const` inside it) so
  // the catch block below can still log a failure against the right
  // conversation even when sendSmsForUser throws - previously a failed
  // reply wrote nothing anywhere (not /logs, not the conversation thread),
  // so there was no trace of it ever having been attempted.
  let uid = "";
  let userData: Record<string, any> = {};
  let to = "";
  let twilioNumber = "";
  let conversationId = "";
  let convoRef: FirebaseFirestore.DocumentReference | null = null;
  let messageBody = "";
  let mediaUrls: string[] = [];

  try {
    const decodedUser = await getUserFromRequest(req);
    uid = decodedUser.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return NextResponse.json(
        { ok: false, error: "User profile not found." },
        { status: 404 }
      );
    }

    userData = userSnap.data() || {};

    if (userData.isActive !== true) {
      return NextResponse.json(
        { ok: false, error: "User account is inactive." },
        { status: 403 }
      );
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const appBaseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");

    twilioNumber = toE164(
      String(userData.twilioNumber || userData.assignedTwilioNumber || "")
    );

    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio configuration." },
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

    const reqBody = await req.json();
    to = toE164(reqBody?.to || reqBody?.phone || "");
    messageBody = String(reqBody?.body || "").trim();
    mediaUrls = normalizeMediaUrls(reqBody?.mediaUrls);

    if (!to) {
      return NextResponse.json(
        { ok: false, error: "Recipient phone is required." },
        { status: 400 }
      );
    }

    // Computed as early as possible (right after `to` is known to be
    // valid) so the catch block below can log a failure against the
    // correct conversation even if sendSmsForUser throws further down.
    conversationId = `${uid}_${phoneDocId(to)}`;
    convoRef = adminDb.collection("conversations").doc(conversationId);

    if (!messageBody && mediaUrls.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Reply body or media is required." },
        { status: 400 }
      );
    }

    if (
      Array.isArray(reqBody?.mediaUrls) &&
      reqBody.mediaUrls.length > 0 &&
      mediaUrls.length === 0
    ) {
      return NextResponse.json(
        { ok: false, error: "All media URLs are invalid. Use public HTTPS URLs." },
        { status: 400 }
      );
    }

    const blocked = await isBlockedNumber(uid, to);
    if (blocked) {
      return NextResponse.json(
        {
          ok: false,
          error: "This number is blocked or opted out and cannot receive messages.",
        },
        { status: 400 }
      );
    }

const messagingServiceSid =
  userData.messagingServiceSid?.trim() ||
  process.env.TWILIO_MESSAGING_SERVICE_SID;

if (!messagingServiceSid) {
  return NextResponse.json(
    { ok: false, error: "Messaging Service SID is missing." },
    { status: 400 }
  );
}

// Routed through the shared sendSmsForUser helper (lib/twilioSend.ts) so
// `from` is always pinned to this user's own number — see that file for
// why that matters.
const msg = await sendSmsForUser({
  userData: { ...userData, messagingServiceSid },
  to,
  body: messageBody,
  mediaUrls,
});

    const threadMessageRef = convoRef.collection("messages").doc(msg.sid);

    const convoSnap = await convoRef.get();
    const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

    const existingUnreadCount = Number(convoData.unreadCount || 0);
    const existingReplyCount = Number(convoData.replyCount || 0);
    const existingName = String(convoData.name || "");
    const existingFirstOutboundAt = convoData.firstOutboundAt || null;
    const existingLastInboundAt = convoData.lastInboundAt || null;
    const existingHasReply = convoData.hasReply === true;

    await threadMessageRef.set({
      sid: msg.sid,
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      phone: to,
      from: msg.from || twilioNumber,
      to,
      body: messageBody,
      mediaUrls,
      numMedia: mediaUrls.length,
      direction: "outbound",
      status: msg.status || "queued",
      read: true,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      conversationId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await convoRef.set(
      {
        ownerUid: uid,
        ownerEmail: String(userData.email || ""),
        ownerName: String(userData.name || ""),
        ownerRole: String(userData.role || "user"),
        phone: to,
        name: existingName,
        twilioNumber,
        assignedTwilioNumber: twilioNumber,
        messagingServiceSid,
        lastMessage: messageBody || (mediaUrls.length > 0 ? "Sent media" : ""),
        lastDirection: "outbound",
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: existingHasReply ? "replied" : "awaiting_reply",
        hasReply: existingHasReply,
        unreadCount: existingUnreadCount,
        replyCount: existingReplyCount,
        outboundCount: FieldValue.increment(1),
        messageCount: FieldValue.increment(1),
        firstOutboundAt: existingFirstOutboundAt || FieldValue.serverTimestamp(),
        lastOutboundAt: FieldValue.serverTimestamp(),
        lastInboundAt: existingLastInboundAt || null,
        lastOutboundStatus: msg.status || "queued",
        // The isBlockedNumber() check above already returned a 400 if this
        // number were currently blocked, so reaching this point guarantees
        // it isn't. Setting this explicitly (instead of leaving it unset)
        // matches the inbound webhook and send-sms/route.ts, which both
        // write this field - without it, conversations only ever touched
        // by a manual reply would have `blocked` missing entirely rather
        // than false, which would silently break any future query that
        // filters on blocked == false.
        blocked: false,
      },
      { merge: true }
    );

    await adminDb.collection("messages").add({
      ownerUid: uid,
      ownerEmail: String(userData.email || ""),
      ownerName: String(userData.name || ""),
      ownerRole: String(userData.role || "user"),
      conversationId,
      phone: to,
      to,
      from: msg.from || twilioNumber,
      body: messageBody,
      mediaUrls,
      numMedia: mediaUrls.length,
      sid: msg.sid,
      twilioSid: msg.sid,
      status: msg.status || "queued",
      direction: "outbound",
      read: true,
      twilioNumber,
      assignedTwilioNumber: twilioNumber,
      messagingServiceSid,
      error: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      ok: true,
      sid: msg.sid,
      status: msg.status || "queued",
      conversationId,
      mediaUrls,
    });
  } catch (error: any) {
    const isBlockedError = error instanceof BlockedNumberError;
    const errorMessage = error?.message || "Failed to send reply.";
    const errorCode = error?.code ? String(error.code) : "";

    console.error("send-reply error:", error);

    // Previously this failure was logged nowhere - not /logs, not the
    // conversation thread, nothing. The only sign was a status message
    // that flashed in the UI for a moment; if missed, there was no
    // permanent record it ever happened. Now every failure (blocked
    // number, invalid recipient, Twilio rejection, etc.) gets written
    // both to the root `messages` collection (so it shows up in /logs,
    // matching how bulk sends already behave) and to the conversation's
    // own thread + summary fields (so it shows up as a red "Delivery
    // Issue" bubble in /replies/[phone] and counts toward the Failed /
    // Undelivered tab) - only possible because uid/to/conversationId/
    // convoRef are now computed before the send attempt, not after it.
    if (uid && to && conversationId && convoRef) {
      try {
        const failedMessageRef = convoRef.collection("messages").doc();

        const convoSnap = await convoRef.get();
        const convoData = convoSnap.exists ? convoSnap.data() || {} : {};

        await failedMessageRef.set({
          sid: "",
          ownerUid: uid,
          ownerEmail: String(userData.email || ""),
          ownerName: String(userData.name || ""),
          ownerRole: String(userData.role || "user"),
          phone: to,
          from: twilioNumber,
          to,
          body: messageBody,
          mediaUrls,
          numMedia: mediaUrls.length,
          direction: "outbound",
          status: "failed",
          error: errorMessage,
          errorCode,
          read: true,
          twilioNumber,
          assignedTwilioNumber: twilioNumber,
          conversationId,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        await convoRef.set(
          {
            ownerUid: uid,
            phone: to,
            twilioNumber,
            assignedTwilioNumber: twilioNumber,
            lastMessage: messageBody || (mediaUrls.length > 0 ? "Sent media" : ""),
            lastDirection: "outbound",
            lastMessageAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            status: "delivery_issue",
            lastOutboundAt: FieldValue.serverTimestamp(),
            lastOutboundStatus: "failed",
            blocked: convoData.blocked === true,
          },
          { merge: true }
        );

        await adminDb.collection("messages").add({
          ownerUid: uid,
          ownerEmail: String(userData.email || ""),
          ownerName: String(userData.name || ""),
          ownerRole: String(userData.role || "user"),
          conversationId,
          phone: to,
          to,
          from: twilioNumber,
          body: messageBody,
          mediaUrls,
          numMedia: mediaUrls.length,
          sid: "",
          twilioSid: "",
          status: "failed",
          direction: "outbound",
          read: true,
          twilioNumber,
          assignedTwilioNumber: twilioNumber,
          error: errorMessage,
          errorCode,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (logError) {
        // Logging the failure is best-effort - if even this write fails
        // (e.g. a genuine Firestore outage), fall through to the same
        // error response the caller would have gotten anyway rather than
        // masking the original error.
        console.error("send-reply: failed to log failure", logError);
      }
    }

    if (isBlockedError) {
      return NextResponse.json({ ok: false, error: errorMessage }, { status: 400 });
    }

    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}