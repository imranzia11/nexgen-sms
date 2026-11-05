import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../lib/firebaseAdmin";
import { getNYMonthRangeUtc, currentNYMonthString, nyDateKey } from "../../../lib/date";
import { countSegments } from "../../../lib/segments";

// Per-account usage billing: SMS SEGMENTS (sent + received) x a flat rate.
// A 160-character text is one segment; longer or emoji texts are several
// (see lib/segments.ts), and each segment is billed.
//
// Only accounts with a positive `billingRatePerSms` on their users/{uid} doc
// get a result - everyone else gets { enabled: false } so the sidebar card
// and page stay hidden. The rate and prepaid credit are written only via the
// Admin SDK (tools/set-billing-rate.ts, the superadmin credit route, and the
// matching lock in firestore.rules), and the counts are always scoped to the
// CALLER's own uid, never a uid sent in the request.
//
// Sources, matching how the rest of the app already defines "sent" and
// "received":
//  - sent:     root `messages` (direction outbound, not failed/undelivered)
//              plus `followUps` with status "sent" (the follow-up cron never
//              logs into root `messages`)
//  - received: root `replies` (one doc per inbound Twilio SID)
// Every query reuses an index already in firestore.indexes.json.

function isFailedStatus(status: unknown) {
  const value = String(status || "").trim().toLowerCase();
  return value === "failed" || value === "undelivered" || value === "canceled";
}

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

type Usage = { sent: number; received: number; sentSegments: number; receivedSegments: number };

// Counts billable messages and segments for one owner in [start, end].
async function usageBetween(
  uid: string,
  start: Date,
  end: Date,
  dayCallback?: (kind: "sent" | "received", date: Date, segments: number) => void
): Promise<Usage> {
  const [outboundSnap, followUpSnap, repliesSnap] = await Promise.all([
    adminDb
      .collection("messages")
      .where("ownerUid", "==", uid)
      .where("createdAt", ">=", start)
      .where("createdAt", "<", end)
      .select("direction", "status", "createdAt", "body")
      .get(),
    adminDb
      .collection("followUps")
      .where("ownerUid", "==", uid)
      .where("sentAt", ">=", start)
      .where("sentAt", "<", end)
      .select("status", "sentAt", "followUpMessage")
      .get(),
    adminDb
      .collection("replies")
      .where("ownerUid", "==", uid)
      .where("createdAt", ">=", start)
      .where("createdAt", "<", end)
      .select("createdAt", "body")
      .get(),
  ]);

  const toDate = (value: unknown): Date | null =>
    value && typeof (value as { toDate?: () => Date }).toDate === "function"
      ? (value as { toDate: () => Date }).toDate()
      : null;

  const usage: Usage = { sent: 0, received: 0, sentSegments: 0, receivedSegments: 0 };

  outboundSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.direction !== "outbound" || isFailedStatus(data.status)) return;
    const date = toDate(data.createdAt);
    if (!date) return;
    const seg = countSegments(data.body);
    usage.sent += 1;
    usage.sentSegments += seg;
    dayCallback?.("sent", date, seg);
  });

  followUpSnap.docs.forEach((d) => {
    const data = d.data();
    if (String(data.status || "").toLowerCase() !== "sent") return;
    const date = toDate(data.sentAt);
    if (!date) return;
    const seg = countSegments(data.followUpMessage);
    usage.sent += 1;
    usage.sentSegments += seg;
    dayCallback?.("sent", date, seg);
  });

  repliesSnap.docs.forEach((d) => {
    const data = d.data();
    const date = toDate(data.createdAt);
    if (!date) return;
    const seg = countSegments(data.body);
    usage.received += 1;
    usage.receivedSegments += seg;
    dayCallback?.("received", date, seg);
  });

  return usage;
}

export async function GET(req: NextRequest) {
  try {
    const decoded = await getUserFromRequest(req);
    const uid = decoded.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    if (userData.isActive !== true) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const rate = Number(userData.billingRatePerSms);
    if (!Number.isFinite(rate) || rate <= 0) {
      return NextResponse.json({ ok: true, enabled: false });
    }

    // Prepaid balance: the credit the superadmin set, minus every billable
    // segment (sent or received) since metering started. Independent of the
    // Twilio account balance.
    let prepaid: {
      creditTotal: number;
      used: number;
      balance: number;
      credits: { amount: number; note: string; at: number }[];
    } | null = null;

    const startedAt =
      userData.billingStartedAt && typeof userData.billingStartedAt.toDate === "function"
        ? (userData.billingStartedAt.toDate() as Date)
        : null;

    if (startedAt) {
      const farFuture = new Date(Date.now() + 60_000);
      const [usage, creditsSnap] = await Promise.all([
        usageBetween(uid, startedAt, farFuture),
        adminDb
          .collection("users")
          .doc(uid)
          .collection("billingCredits")
          .orderBy("createdAt", "desc")
          .limit(10)
          .get(),
      ]);

      const creditTotal = Number(userData.billingCreditTotal) || 0;
      const used =
        Math.round((usage.sentSegments + usage.receivedSegments) * rate * 100) / 100;
      prepaid = {
        creditTotal,
        used,
        balance: Math.round((creditTotal - used) * 100) / 100,
        credits: creditsSnap.docs.map((d) => {
          const c = d.data();
          return {
            amount: Number(c.amount) || 0,
            note: String(c.note || ""),
            at:
              c.createdAt && typeof c.createdAt.toMillis === "function"
                ? c.createdAt.toMillis()
                : 0,
          };
        }),
      };
    }

    // Cheap probe for the sidebar: visibility + internal balance only.
    if (req.nextUrl.searchParams.get("check") === "1") {
      return NextResponse.json({
        ok: true,
        enabled: true,
        prepaid: prepaid ? { balance: prepaid.balance, creditTotal: prepaid.creditTotal } : null,
      });
    }

    const configuredMax = Number(userData.billingSelfCreditMax);
    const selfCreditMax =
      Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 500;
    const creditLocked = userData.billingCreditLocked === true;

    const requested = req.nextUrl.searchParams.get("month") || "";
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
      ? requested
      : currentNYMonthString();
    const { start, end, daysInMonth } = getNYMonthRangeUtc(month);

    const sentSegByDay: Record<number, number> = {};
    const receivedSegByDay: Record<number, number> = {};
    const sentByDay: Record<number, number> = {};
    const receivedByDay: Record<number, number> = {};

    const usage = await usageBetween(uid, start, end, (kind, date, seg) => {
      const day = Number(nyDateKey(date).split("-")[2]);
      if (kind === "sent") {
        sentByDay[day] = (sentByDay[day] || 0) + 1;
        sentSegByDay[day] = (sentSegByDay[day] || 0) + seg;
      } else {
        receivedByDay[day] = (receivedByDay[day] || 0) + 1;
        receivedSegByDay[day] = (receivedSegByDay[day] || 0) + seg;
      }
    });

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const s = sentByDay[day] || 0;
      const r = receivedByDay[day] || 0;
      const segments = (sentSegByDay[day] || 0) + (receivedSegByDay[day] || 0);
      return {
        day,
        sent: s,
        received: r,
        segments,
        amount: Math.round(segments * rate * 100) / 100,
      };
    });

    const totalSegments = usage.sentSegments + usage.receivedSegments;

    return NextResponse.json({
      ok: true,
      enabled: true,
      prepaid,
      creditLocked,
      selfCreditMax,
      month,
      rate,
      sent: usage.sent,
      received: usage.received,
      sentSegments: usage.sentSegments,
      receivedSegments: usage.receivedSegments,
      totalSegments,
      total: usage.sent + usage.received,
      amount: Math.round(totalSegments * rate * 100) / 100,
      days,
    });
  } catch (error: any) {
    console.error("Billing route failed", error);
    return NextResponse.json(
      { ok: false, error: error?.message || "Failed to load billing." },
      { status: 500 }
    );
  }
}
