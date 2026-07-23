import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../../lib/firebaseAdmin";
import { getNYDayRangeUtc, nyDateKey, todayNYDateString } from "../../../../../lib/date";

// Per-account detail for the superadmin dashboard: login history for the
// past 5 days, plus the total SMS sent count for that one account. Same
// superadmin-only gate as /api/admin/overview - see that file for why this
// is safe to read cross-account (Admin SDK bypasses firestore.rules, but
// only after this route itself verifies the CALLER is the superadmin).

const LOOKBACK_DAYS = 5;

function toMillis(value: unknown): number {
  if (!value) return 0;
  if (typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  if (typeof (value as { seconds?: number }).seconds === "number") {
    return (value as { seconds: number }).seconds * 1000;
  }
  return 0;
}

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  try {
    const decodedUser = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decodedUser.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};

    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json(
        { ok: false, error: "Forbidden." },
        { status: 403 }
      );
    }

    const { uid } = await params;

    const targetSnap = await adminDb.collection("users").doc(uid).get();
    if (!targetSnap.exists) {
      return NextResponse.json(
        { ok: false, error: "Account not found." },
        { status: 404 }
      );
    }
    const targetData = targetSnap.data() || {};

    // No orderBy here on purpose - an equality filter (ownerUid) plus an
    // orderBy on a different field (loginAt) would need a new composite
    // index deployed. Login volume per account is naturally tiny (a
    // handful a day at most), so fetching up to 200 and sorting/filtering
    // in memory below is effectively free and needs zero new indexes.
    // smsSentCount sums two sources: the root `messages` collection (every
    // regular send + manual reply) plus followUps where status=="sent" -
    // the follow-up cron (app/api/cron/send-followups/route.ts) only ever
    // logs a sent follow-up into the conversation's messages SUBcollection,
    // never this root one, so it would otherwise be invisible here. Both
    // queries below are equality-only, so neither needs a new index.
    // Covers the whole LOOKBACK_DAYS window in one query (today's count and
    // the per-day breakdown both come out of this same result set - no
    // separate query needed for "today" specifically). Reuses the exact
    // query shape already proven safe on /stats and /logs (ownerUid
    // equality + createdAt range + orderBy createdAt desc) - that's the one
    // composite index already deployed for `messages` (see
    // firestore.indexes.json). A three-field query (ownerUid + direction +
    // createdAt range) would need a brand-new, undeployed index instead, so
    // `direction` is filtered in memory below rather than added to the
    // query itself - same trade-off already made on the stats page. Capped
    // at limit(20000): a realistic ceiling for one account's messages
    // across a 5-day window.
    const windowStartDateStr = nyDateKey(
      new Date(Date.now() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000)
    );
    const { start: windowStart } = getNYDayRangeUtc(windowStartDateStr);
    const { end: windowEnd } = getNYDayRangeUtc(todayNYDateString());

    const [
      loginSnap,
      sentSnap,
      followUpSentSnap,
      windowMessagesSnap,
      allSentFollowUpsSnap,
    ] = await Promise.all([
      adminDb
        .collection("loginHistory")
        .where("ownerUid", "==", uid)
        .limit(200)
        .get(),
      adminDb
        .collection("messages")
        .where("ownerUid", "==", uid)
        .where("direction", "==", "outbound")
        .count()
        .get(),
      adminDb
        .collection("followUps")
        .where("ownerUid", "==", uid)
        .where("status", "==", "sent")
        .count()
        .get(),
      adminDb
        .collection("messages")
        .where("ownerUid", "==", uid)
        .where("createdAt", ">=", windowStart)
        .where("createdAt", "<", windowEnd)
        .orderBy("createdAt", "desc")
        .limit(20000)
        .get(),
      // BUG FIX: the per-day breakdown used to only count the root
      // `messages` collection, silently leaving out every follow-up send -
      // on a day where a large batch of follow-ups went out, the daily
      // chart and "Sent Today" ring showed a fraction of what actually
      // went out (confirmed live: a day showing 5,075 here was actually
      // 7,000+ once follow-ups were included). smsSentCount (the all-time
      // total) already summed both sources - this brings the daily
      // breakdown in line with that same definition.
      //
      // No `sentAt` range filter here on purpose - combining that with the
      // existing ownerUid/status equality filters would need a brand-new,
      // undeployed composite index (same constraint noted above for
      // loginHistory). Fetching every sent follow-up for the account
      // instead (pure equality, already proven safe/no-index-needed by the
      // followUpSentSnap count query above) and bucketing by day in memory
      // avoids that, at the cost of reading more documents than strictly
      // needed for a rarely-loaded superadmin page - worth it for
      // correctness. Capped at 50000 purely as a hard safety ceiling, not
      // expected to bind in practice.
      adminDb
        .collection("followUps")
        .where("ownerUid", "==", uid)
        .where("status", "==", "sent")
        .limit(50000)
        .get(),
    ]);

    // Same "regular sends + manual replies + follow-up sends" definition as
    // smsSentCount below, just narrowed to this window and bucketed by NY
    // calendar day so the per-day breakdown lines up with the same "day"
    // the rest of the app means everywhere else (lib/date.ts).
    const sentCountByDay = new Map<string, number>();
    windowMessagesSnap.docs.forEach((d) => {
      const data = d.data();
      if (data?.direction !== "outbound") return;
      const createdAt = data?.createdAt;
      const createdAtDate =
        typeof createdAt?.toDate === "function" ? createdAt.toDate() : null;
      if (!createdAtDate) return;
      const key = nyDateKey(createdAtDate);
      sentCountByDay.set(key, (sentCountByDay.get(key) || 0) + 1);
    });
    allSentFollowUpsSnap.docs.forEach((d) => {
      const data = d.data();
      const sentAt = data?.sentAt;
      const sentAtDate =
        typeof sentAt?.toDate === "function" ? sentAt.toDate() : null;
      if (!sentAtDate) return;
      const key = nyDateKey(sentAtDate);
      sentCountByDay.set(key, (sentCountByDay.get(key) || 0) + 1);
    });

    const dailySentCounts: { date: string; count: number }[] = [];
    for (let i = LOOKBACK_DAYS - 1; i >= 0; i--) {
      const dateStr = nyDateKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
      dailySentCounts.push({
        date: dateStr,
        count: sentCountByDay.get(dateStr) || 0,
      });
    }

    const todaySentCount =
      dailySentCounts[dailySentCounts.length - 1]?.count || 0;

    const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    const loginHistory = loginSnap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          loginAtMs: toMillis(data.loginAt),
        };
      })
      .filter((entry) => entry.loginAtMs >= cutoffMs)
      .sort((a, b) => b.loginAtMs - a.loginAtMs);

    return NextResponse.json({
      ok: true,
      account: {
        uid,
        name: String(targetData.name || ""),
        email: String(targetData.email || ""),
        isActive: targetData.isActive === true,
        twilioNumber: String(
          targetData.twilioNumber || targetData.assignedTwilioNumber || ""
        ),
        smsSentCount: sentSnap.data().count + followUpSentSnap.data().count,
        todaySentCount,
      },
      loginHistory: loginHistory.map((entry) => ({
        id: entry.id,
        loginAt: new Date(entry.loginAtMs).toISOString(),
      })),
      dailySentCounts,
      lookbackDays: LOOKBACK_DAYS,
    });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
