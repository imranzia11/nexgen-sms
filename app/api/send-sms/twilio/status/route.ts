import { NextRequest } from "next/server";
import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function xmlResponse() {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

// Twilio can fire the queued -> sent -> delivered webhooks in very quick
// succession (sometimes under 2 seconds apart). Each callback is handled
// as an independent, concurrent request, so there is no guarantee they
// finish writing to Firestore in the same order the statuses actually
// occurred in. Without a rank check, a slower "queued" handler can finish
// AFTER a faster "delivered" handler and silently overwrite the correct
// final status with an earlier, stale one. This rank map lets us ignore
// any incoming status that is older than what's already stored.
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  accepted: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
};

function rankOf(status: string) {
  const key = String(status || "").toLowerCase();
  return key in STATUS_RANK ? STATUS_RANK[key] : -1;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    );

    const signature = req.headers.get("x-twilio-signature") || "";
    const authToken = process.env.TWILIO_AUTH_TOKEN || "";

    const appBaseUrl = process.env.APP_BASE_URL?.trim();
    const requestUrl = appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/api/send-sms/twilio/status`
      : req.url;

    // Same fix as the inbound webhook: require the signature header
    // whenever we're configured to check one, instead of silently skipping
    // validation when it's simply absent.
    if (authToken) {
      if (!signature) {
        console.error("Missing Twilio status callback signature");
        return xmlResponse();
      }

      const valid = twilio.validateRequest(
        authToken,
        signature,
        requestUrl,
        params
      );

      if (!valid) {
        console.error("Invalid Twilio status callback signature");
        return xmlResponse();
      }
    }

    const messageSid = String(params.MessageSid || "").trim();
    const messageStatus = String(params.MessageStatus || "").trim().toLowerCase();
    const errorCode = String(params.ErrorCode || "").trim();
    const errorMessage = String(params.ErrorMessage || "").trim();

    if (!messageSid || !messageStatus) {
      return xmlResponse();
    }

    const now = FieldValue.serverTimestamp();
    const incomingRank = rankOf(messageStatus);
    const finalError =
      errorMessage ||
      ((messageStatus === "failed" || messageStatus === "undelivered")
        ? errorCode
        : "");

    const rootMessagesSnap = await adminDb
      .collection("messages")
      .where("sid", "==", messageSid)
      .get();

    for (const docSnap of rootMessagesSnap.docs) {
      const existingStatus = String(docSnap.data()?.status || "");

      // Skip writes that would move a message backwards in its lifecycle
      // (e.g. an out-of-order "queued" arriving after "delivered" already
      // landed). Unranked/unknown existing statuses are always allowed
      // through so this never blocks a first-ever write.
      if (
        rankOf(existingStatus) !== -1 &&
        incomingRank !== -1 &&
        incomingRank < rankOf(existingStatus)
      ) {
        continue;
      }

      await docSnap.ref.set(
        {
          status: messageStatus,
          error: finalError,
          errorCode: errorCode || "",
          statusUpdatedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    const conversationMessagesSnap = await adminDb
      .collectionGroup("messages")
      .where("sid", "==", messageSid)
      .get();

    let conversationRef: FirebaseFirestore.DocumentReference | null = null;

    for (const docSnap of conversationMessagesSnap.docs) {
      const existingStatus = String(docSnap.data()?.status || "");

      if (
        rankOf(existingStatus) !== -1 &&
        incomingRank !== -1 &&
        incomingRank < rankOf(existingStatus)
      ) {
        if (!conversationRef) {
          conversationRef = docSnap.ref.parent.parent;
        }
        continue;
      }

      await docSnap.ref.set(
        {
          status: messageStatus,
          error: finalError,
          errorCode: errorCode || "",
          statusUpdatedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      if (!conversationRef) {
        conversationRef = docSnap.ref.parent.parent;
      }
    }

    if (conversationRef) {
      const conversationSnap = await conversationRef.get();
      const conversationData = conversationSnap.exists
        ? conversationSnap.data() || {}
        : {};

      const existingLastOutboundStatus = String(
        conversationData.lastOutboundStatus || ""
      );

      const conversationRank = rankOf(existingLastOutboundStatus);

      // Same out-of-order guard, applied to the conversation summary
      // fields (lastOutboundStatus / status) so the thread list and
      // conversation header can't regress either.
      if (
        conversationRank === -1 ||
        incomingRank === -1 ||
        incomingRank >= conversationRank
      ) {
        const patch: Record<string, unknown> = {
          updatedAt: now,
          lastOutboundStatus: messageStatus,
        };

        if (messageStatus === "failed" || messageStatus === "undelivered") {
          patch.status = "delivery_issue";
        } else {
          patch.status =
            conversationData.hasReply === true ? "replied" : "awaiting_reply";
        }

        await conversationRef.set(patch, { merge: true });
      }
    }

    return xmlResponse();
  } catch (error) {
    console.error("Twilio status callback error:", error);
    return xmlResponse();
  }
}
