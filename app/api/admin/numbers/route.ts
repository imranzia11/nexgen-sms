import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../lib/phone";

// Superadmin-only: the Twilio numbers on the account that are NOT currently
// assigned to an active portal account - i.e. the numbers a new or
// re-enabled account can be given. Feeds the number dropdown on /admin.
//
// A number counts as taken if it has a numberAssignments record OR is on an
// active user's doc. Disabling an account releases its number (see
// app/api/admin/account/[uid]/status/route.ts), so it shows up here again.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

type TwilioNumber = { phone_number?: string; friendly_name?: string };

export async function GET(req: NextRequest) {
  try {
    const decoded = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};
    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Missing Twilio configuration." },
        { status: 500 }
      );
    }

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=1000`,
      {
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        },
        cache: "no-store",
      }
    );
    const twilioBody = (await twilioRes.json().catch(() => ({}))) as {
      incoming_phone_numbers?: TwilioNumber[];
      message?: string;
    };

    if (!twilioRes.ok) {
      return NextResponse.json(
        { ok: false, error: twilioBody.message || "Failed to load Twilio numbers." },
        { status: 502 }
      );
    }

    const [assignmentsSnap, usersSnap] = await Promise.all([
      adminDb.collection("numberAssignments").get(),
      adminDb.collection("users").where("isActive", "==", true).get(),
    ]);

    const taken = new Set<string>();
    assignmentsSnap.docs.forEach((d) => taken.add(toE164(d.id)));
    usersSnap.docs.forEach((d) => {
      const data = d.data() || {};
      const n = toE164(String(data.twilioNumber || data.assignedTwilioNumber || ""));
      if (n) taken.add(n);
    });

    // ?all=1 -> every number on the Twilio account with who holds it and how
    // it has been used for calls (the Numbers panel on /admin).
    if (req.nextUrl.searchParams.get("all") === "1") {
      const assignmentOwner = new Map<string, string>();
      assignmentsSnap.docs.forEach((d) =>
        assignmentOwner.set(toE164(d.id), String(d.data()?.ownerUid || ""))
      );

      // uid -> account, from user docs (active or not), for the owner column.
      const allUsers = await adminDb.collection("users").get();
      const byNumber = new Map<string, { uid: string; email: string; name: string; active: boolean }>();
      const byUid = new Map<string, { uid: string; email: string; name: string; active: boolean }>();
      allUsers.docs.forEach((d) => {
        const u = d.data() || {};
        const info = {
          uid: d.id,
          email: String(u.email || ""),
          name: String(u.name || ""),
          active: u.isActive === true,
        };
        byUid.set(d.id, info);
        const n = toE164(String(u.twilioNumber || u.assignedTwilioNumber || ""));
        if (n && u.isActive === true) byNumber.set(n, info);
      });

      // Calls placed in the last 30 days, grouped by caller ID. The 24-hour
      // count and "last used" both come from this one range query.
      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const since = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const callsSnap = await adminDb
        .collection("calls")
        .where("createdAt", ">=", since)
        .select("from", "createdAt")
        .get();

      const stats = new Map<string, { calls24h: number; lastMs: number }>();
      callsSnap.docs.forEach((d) => {
        const from = toE164(String(d.get("from") || ""));
        if (!from) return;
        const ms = d.get("createdAt")?.toMillis?.() || 0;
        const s = stats.get(from) || { calls24h: 0, lastMs: 0 };
        if (ms >= dayAgo) s.calls24h += 1;
        if (ms > s.lastMs) s.lastMs = ms;
        stats.set(from, s);
      });

      const rows = (twilioBody.incoming_phone_numbers || [])
        .map((n) => {
          const phoneNumber = toE164(String(n.phone_number || ""));
          const ownerUid = assignmentOwner.get(phoneNumber) || "";
          const owner =
            (ownerUid && byUid.get(ownerUid)) || byNumber.get(phoneNumber) || null;
          const s = stats.get(phoneNumber);
          return {
            phoneNumber,
            friendlyName: String(n.friendly_name || n.phone_number || ""),
            assigned: taken.has(phoneNumber),
            ownerUid: owner?.uid || ownerUid,
            ownerEmail: owner?.email || "",
            ownerName: owner?.name || "",
            calls24h: s?.calls24h || 0,
            lastCallAt: s?.lastMs ? new Date(s.lastMs).toISOString() : "",
          };
        })
        .filter((n) => n.phoneNumber)
        .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));

      return NextResponse.json({ ok: true, numbers: rows });
    }

    const numbers = (twilioBody.incoming_phone_numbers || [])
      .map((n) => ({
        phoneNumber: toE164(String(n.phone_number || "")),
        friendlyName: String(n.friendly_name || n.phone_number || ""),
      }))
      .filter((n) => n.phoneNumber && !taken.has(n.phoneNumber))
      .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));

    return NextResponse.json({ ok: true, numbers });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
