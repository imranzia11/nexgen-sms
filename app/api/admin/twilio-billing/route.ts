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
};

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

    const [balanceRes, usageRes] = await Promise.all([
      fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`,
        { headers: { Authorization: basicAuth } }
      ),
      fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records/ThisMonth.json?PageSize=200`,
        { headers: { Authorization: basicAuth } }
      ),
    ]);

    if (!balanceRes.ok) {
      throw new Error(`Twilio balance request failed (${balanceRes.status})`);
    }
    if (!usageRes.ok) {
      throw new Error(`Twilio usage request failed (${usageRes.status})`);
    }

    const balanceJson = await balanceRes.json();
    const usageJson = await usageRes.json();

    const records: UsageRecord[] = Array.isArray(usageJson.usage_records)
      ? usageJson.usage_records
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
    });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
