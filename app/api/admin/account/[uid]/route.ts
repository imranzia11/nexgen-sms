import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../../lib/firebaseAdmin";

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
    const [loginSnap, sentSnap, followUpSentSnap] = await Promise.all([
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
    ]);

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
      },
      loginHistory: loginHistory.map((entry) => ({
        id: entry.id,
        loginAt: new Date(entry.loginAtMs).toISOString(),
      })),
      lookbackDays: LOOKBACK_DAYS,
    });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
