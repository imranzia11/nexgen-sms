import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";

// Superadmin-only Twilio billing snapshot. There is exactly ONE Twilio
// account (one Account SID/Auth Token) shared across every rep in this
// platform - Twilio has no concept of "Sunny" vs "Nate", so this can only
// ever be a company-wide number, never a per-rep breakdown. That's why this
// lives behind the same superadmin gate as /api/admin/overview, rather than
// being shown on any individual rep's dashboard.
//
// Talks to Twilio's plain REST API directly (Basic Auth with Account SID +
// Auth Token) instead of the `twilio` npm client's usage/balance
// sub-resources, to avoid any uncertainty about that SDK surface across
// versions - these are simple, stable, documented GET endpoints.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

type UsageRecord = {
  category: string;
  description: string;
  count: string;
  usage: string;
  usage_unit: string;
  price: string;
  price_unit: string;
  start_date?: string;
  end_date?: string;
};

// Twilio's Usage Records API only exposes carrier surcharges as two
// aggregate categories - sms-messages-carrierfees and
// mms-messages-carrierfees - covering ALL carriers combined. There is no
// public API that breaks this down by carrier name (AT&T vs Verizon vs
// T-Mobile, etc). Getting that would require running every destination
// number through Twilio's separate, paid Lookup API (~$0.005-0.01 per
// number, charged on top of the SMS itself) just to attribute a carrier -
// so it's a real added cost, not a free breakdown, and isn't built here.
const CARRIER_FEE_CATEGORIES = new Set([
  "sms-messages-carrierfees",
  "mms-messages-carrierfees",
]);

function dateKeyDaysAgo(daysAgo: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    const decodedUser = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decodedUser.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};

    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return NextResponse.json(
        { ok: false, error: "Twilio account is not configured." },
        { status: 500 }
      );
    }

    const basicAuth =
      "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    // Daily granularity, last 5 days (today + 4 prior) - one call, then
    // grouped client-side by start_date. This is what powers today /
    // yesterday / 5-day figures below.
    const dailyStart = dateKeyDaysAgo(4);
    const dailyEnd = dateKeyDaysAgo(0);

    const [balanceRes, usageRes, dailyUsageRes] = await Promise.all([
      fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`,
        { headers: { Authorization: basicAuth } }
      ),
      fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records/ThisMonth.json?PageSize=200`,
        { headers: { Authorization: basicAuth } }
      ),
      fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records/Daily.json?StartDate=${dailyStart}&EndDate=${dailyEnd}&PageSize=1000`,
        { headers: { Authorization: basicAuth } }
      ),
    ]);

    if (!balanceRes.ok) {
      throw new Error(`Twilio balance request failed (${balanceRes.status})`);
    }
    if (!usageRes.ok) {
      throw new Error(`Twilio usage request failed (${usageRes.status})`);
    }
    if (!dailyUsageRes.ok) {
      throw new Error(`Twilio daily usage request failed (${dailyUsageRes.status})`);
    }

    const balanceJson = await balanceRes.json();
    const usageJson = await usageRes.json();
    const dailyUsageJson = await dailyUsageRes.json();

    const records: UsageRecord[] = Array.isArray(usageJson.usage_records)
      ? usageJson.usage_records
      : [];

    const dailyRecords: UsageRecord[] = Array.isArray(dailyUsageJson.usage_records)
      ? dailyUsageJson.usage_records
      : [];

    // Twilio reports `price` as a negative number (money leaving the
    // account) - flipped to a positive spend figure for display. Zero-spend
    // categories (free inbound reads, etc.) are dropped so the breakdown
    // only shows things that actually cost money this month.
    const byCategory = records
      .map((r) => ({
        category: r.category,
        description: r.description,
        spend: Math.abs(parseFloat(r.price || "0")) || 0,
        unit: r.price_unit || "usd",
        count: r.count || "0",
      }))
      .filter((r) => r.spend > 0)
      .sort((a, b) => b.spend - a.spend);

    const monthToDateTotal = byCategory.reduce((sum, r) => sum + r.spend, 0);

    // Group the daily records by calendar date (UTC, matching Twilio's
    // start_date). Each date accumulates a total spend plus, separately,
    // the slice of that spend that was carrier surcharges - the closest
    // free proxy to "how much did carriers charge us," since Twilio
    // doesn't expose per-carrier-name figures (see note above).
    const byDate = new Map<
      string,
      { total: number; carrierFees: number; currency: string }
    >();

    for (const r of dailyRecords) {
      const dateKey = r.start_date || "";
      if (!dateKey) continue;
      const spend = Math.abs(parseFloat(r.price || "0")) || 0;
      if (spend <= 0) continue;

      const entry = byDate.get(dateKey) || {
        total: 0,
        carrierFees: 0,
        currency: (r.price_unit || "usd").toLowerCase(),
      };
      entry.total += spend;
      if (CARRIER_FEE_CATEGORIES.has(r.category)) {
        entry.carrierFees += spend;
      }
      byDate.set(dateKey, entry);
    }

    // Always emit an entry for each of the 5 days, even $0 ones, so the
    // UI can show a full week strip rather than gaps where nothing was
    // sent.
    const dailySpend = [];
    for (let i = 4; i >= 0; i--) {
      const dateKey = dateKeyDaysAgo(i);
      const entry = byDate.get(dateKey);
      dailySpend.push({
        date: dateKey,
        total: entry?.total || 0,
        carrierFees: entry?.carrierFees || 0,
        currency: entry?.currency || "usd",
      });
    }

    const todayKey = dateKeyDaysAgo(0);
    const yesterdayKey = dateKeyDaysAgo(1);

    return NextResponse.json({
      ok: true,
      balance: {
        amount: parseFloat(balanceJson.balance || "0") || 0,
        currency: String(balanceJson.currency || "usd").toLowerCase(),
      },
      monthToDate: {
        total: monthToDateTotal,
        currency: (byCategory[0]?.unit || "usd").toLowerCase(),
        byCategory: byCategory.slice(0, 8),
      },
      today: dailySpend.find((d) => d.date === todayKey) || null,
      yesterday: dailySpend.find((d) => d.date === yesterdayKey) || null,
      dailySpend,
      carrierNote:
        "Twilio only reports carrier surcharges as one combined total (all carriers together) - it doesn't break out AT&T vs Verizon vs T-Mobile by name via any free API. Getting a true per-carrier split would mean running every destination number through Twilio's paid Lookup API, which adds its own per-message cost.",
    });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
