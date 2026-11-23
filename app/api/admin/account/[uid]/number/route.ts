import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../../../lib/phone";

// Superadmin-only: move an ACTIVE account to a different Twilio number.
//
//  1. the new number is claimed in numberAssignments with create(), so it
//     fails if any other account already owns it
//  2. users/{uid}.twilioNumber / assignedTwilioNumber are switched
//  3. the old number's assignment is deleted (only if it belonged to this
//     account), which frees it for someone else
//
// New texts and calls go out from the new number straight away, and replies
// to it land on this account. Customers who reply to the OLD number reach
// whoever holds that number next, so the old number is released only after
// the switch has succeeded. Existing conversations keep their history.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  try {
    const decoded = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};
    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return fail("Forbidden.", 403);
    }

    const { uid } = await params;
    const body = await req.json().catch(() => ({}));
    const wanted = toE164(String(body?.twilioNumber || ""));
    if (!/^\+\d{8,15}$/.test(wanted)) {
      return fail("Select a valid Twilio number.", 400);
    }

    const targetRef = adminDb.collection("users").doc(uid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) return fail("Account not found.", 404);
    const target = targetSnap.data() || {};
    if (String(target.role || "").toLowerCase() === "superadmin") {
      return fail("Superadmin accounts can't be changed here.", 400);
    }
    if (target.isActive !== true) {
      return fail("Enable the account first - disabled accounts get a number when enabled.", 400);
    }

    const current = toE164(String(target.twilioNumber || target.assignedTwilioNumber || ""));
    if (current === wanted) return fail("The account already uses that number.", 400);

    // The number must really exist on the Twilio account.
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return fail("Missing Twilio configuration.", 500);
    const check = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
        wanted
      )}`,
      {
        headers: {
          Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        },
        cache: "no-store",
      }
    );
    const checkBody = (await check.json().catch(() => ({}))) as {
      incoming_phone_numbers?: unknown[];
    };
    if (!check.ok || !(checkBody.incoming_phone_numbers || []).length) {
      return fail("That number isn't on the Twilio account.", 400);
    }

    // 1. Claim the new number.
    const newAssignment = adminDb.collection("numberAssignments").doc(wanted);
    try {
      await newAssignment.create({ ownerUid: uid, phoneNumberSid: "", createdAt: new Date() });
    } catch {
      return fail("That Twilio number is already assigned to another account.", 409);
    }

    // 2. Switch the account over.
    try {
      await targetRef.set(
        {
          twilioNumber: wanted,
          assignedTwilioNumber: wanted,
          previousTwilioNumber: current || FieldValue.delete(),
          statusUpdatedAt: FieldValue.serverTimestamp(),
          statusUpdatedBy: decoded.uid,
        },
        { merge: true }
      );
    } catch (e) {
      await newAssignment.delete().catch(() => {});
      throw e;
    }

    // 3. Release the old number.
    if (current) {
      const oldRef = adminDb.collection("numberAssignments").doc(current);
      const oldSnap = await oldRef.get();
      if (oldSnap.exists && oldSnap.data()?.ownerUid === uid) {
        await oldRef.delete();
      }
    }

    return NextResponse.json({ ok: true, uid, twilioNumber: wanted, releasedNumber: current });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return fail(message, 500);
  }
}
