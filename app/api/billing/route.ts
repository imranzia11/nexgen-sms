import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../lib/firebaseAdmin";
import { getNYMonthRangeUtc, currentNYMonthString, nyDateKey } from "../../../lib/date";

// Per-account usage billing: (SMS sent + SMS received) x a flat per-SMS rate.
// Only accounts with a positive `billingRatePerSms` on their users/{uid} doc
// get a result - everyone else gets { enabled: false } so the sidebar card
// and page stay hidden. The rate is written only via the Admin SDK (see
// tools/set-billing-rate.ts and the matching lock in firestore.rules), and
// the counts are always scoped to the CALLER's own uid, never a uid sent
// in the request.
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

    // Cheap visibility probe for the sidebar card - skips all the counting.
    if (req.nextUrl.searchParams.get("check") === "1") {
      return NextResponse.json({ ok: true, enabled: true });
    }

    const requested = req.nextUrl.searchParams.get("month") || "";
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
      ? requested
      : currentNYMonthString();
    const { start, end, daysInMonth } = getNYMonthRangeUtc(month);

    const [outboundSnap, followUpSnap, receivedCount] = await Promise.all([
      adminDb
        .collection("messages")
        .where("ownerUid", "==", uid)
        .where("createdAt", ">=", start)
        .where("createdAt", "<", end)
        .select("direction", "status", "createdAt")
        .get(),
      adminDb
        .collection("followUps")
        .where("ownerUid", "==", uid)
        .where("sentAt", ">=", start)
        .where("sentAt", "<", end)
        .select("status", "sentAt")
        .get(),
      adminDb
        .collection("replies")
        .where("ownerUid", "==", uid)
        .where("createdAt", ">=", start)
        .where("createdAt", "<", end)
        .select("createdAt")
        .get(),
    ]);

    const sentByDay: Record<number, number> = {};
    const receivedByDay: Record<number, number> = {};
    let sent = 0;
    let received = 0;

    const dayOf = (value: unknown): number | null => {
      const date =
        value && typeof (value as { toDate?: () => Date }).toDate === "function"
          ? (value as { toDate: () => Date }).toDate()
          : null;
      return date ? Number(nyDateKey(date).split("-")[2]) : null;
    };

    outboundSnap.docs.forEach((d) => {
      const data = d.data();
      if (data.direction !== "outbound" || isFailedStatus(data.status)) return;
      const day = dayOf(data.createdAt);
      if (day === null) return;
      sent += 1;
      sentByDay[day] = (sentByDay[day] || 0) + 1;
    });

    followUpSnap.docs.forEach((d) => {
      const data = d.data();
      if (String(data.status || "").toLowerCase() !== "sent") return;
      const day = dayOf(data.sentAt);
      if (day === null) return;
      sent += 1;
      sentByDay[day] = (sentByDay[day] || 0) + 1;
    });

    receivedCount.docs.forEach((d) => {
      const day = dayOf(d.data().createdAt);
      if (day === null) return;
      received += 1;
      receivedByDay[day] = (receivedByDay[day] || 0) + 1;
    });

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const s = sentByDay[day] || 0;
      const r = receivedByDay[day] || 0;
      return { day, sent: s, received: r, amount: Math.round((s + r) * rate * 100) / 100 };
    });

    const total = sent + received;

    return NextResponse.json({
      ok: true,
      enabled: true,
      month,
      rate,
      sent,
      received,
      total,
      amount: Math.round(total * rate * 100) / 100,
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
