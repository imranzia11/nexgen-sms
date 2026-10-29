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
