import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../../../lib/phone";

// Superadmin-only: choose the number an account DIALS from.
//
// The text number (twilioNumber) stays fixed. callNumber is optional: when
// empty, calls use the text number. A calling number is claimed in
// callNumberAssignments (create() fails if another account holds it) and can
// only be a Twilio number nobody uses for texting or calling.
//
// POST { callNumber: "+1..." }  -> set
// POST { callNumber: "" }       -> back to the text number

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
    const raw = String(body?.callNumber || "").trim();
    const wanted = raw ? toE164(raw) : "";
    if (wanted && !/^\+\d{8,15}$/.test(wanted)) {
      return fail("Select a valid Twilio number.", 400);
    }

    const targetRef = adminDb.collection("users").doc(uid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) return fail("Account not found.", 404);
    const target = targetSnap.data() || {};
    if (String(target.role || "").toLowerCase() === "superadmin") {
      return fail("Superadmin accounts can't be changed here.", 400);
    }
    if (target.isActive !== true) return fail("Enable the account first.", 400);

    const smsNumber = toE164(String(target.twilioNumber || target.assignedTwilioNumber || ""));
    const current = toE164(String(target.callNumber || ""));
    if (wanted === smsNumber || wanted === current) {
      if (wanted === smsNumber && current) {
        // Choosing the text number = reset to default.
      } else {
        return fail("The account already dials from that number.", 400);
      }
    }
    const effective = wanted === smsNumber ? "" : wanted;

    if (effective) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      if (!accountSid || !authToken) return fail("Missing Twilio configuration.", 500);
      const check = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
          effective
        )}`,
        {
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
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

      // Must not be a text number of anyone.
      const textTaken = await adminDb.collection("numberAssignments").doc(effective).get();
      if (textTaken.exists) {
        return fail("That number is already used as a text number.", 409);
      }

      try {
        await adminDb
          .collection("callNumberAssignments")
          .doc(effective)
          .create({ ownerUid: uid, createdAt: new Date() });
      } catch {
        return fail("That number is already used as a calling number.", 409);
      }
    }

    try {
      await targetRef.set(
        {
          callNumber: effective,
          statusUpdatedAt: FieldValue.serverTimestamp(),
          statusUpdatedBy: decoded.uid,
        },
        { merge: true }
      );
    } catch (e) {
      if (effective) {
        await adminDb.collection("callNumberAssignments").doc(effective).delete().catch(() => {});
      }
      throw e;
    }

    // Release the previous calling number.
    if (current && current !== effective) {
      const oldRef = adminDb.collection("callNumberAssignments").doc(current);
      const oldSnap = await oldRef.get();
      if (oldSnap.exists && oldSnap.data()?.ownerUid === uid) await oldRef.delete();
    }

    return NextResponse.json({
      ok: true,
      uid,
      callNumber: effective,
      dialsFrom: effective || smsNumber,
      releasedNumber: current,
    });
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : "Unexpected server error", 500);
  }
}
