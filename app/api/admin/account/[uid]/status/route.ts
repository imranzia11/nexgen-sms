import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../../../lib/phone";

// Superadmin-only: enable or disable one account.
//
// DISABLE
//  1. users/{uid}.isActive = false - every page and the login screen already
//     check this and sign the user straight back out.
//  2. The account's Twilio number is RELEASED: its numberAssignments record
//     is deleted and the number is cleared off the user doc (remembered in
//     releasedTwilioNumber), so the number can be given to another account.
//  3. The Firebase Auth user is disabled and its refresh tokens revoked, so
//     sign-in is refused and any open session stops refreshing.
//
// ENABLE
//  - The account needs a number again. If it still holds one (disabled
//    before number release existed) that is kept; otherwise the request must
//    include `twilioNumber`, which is claimed the same way account creation
//    does (numberAssignments create() fails if another account owns it).
//
// Superadmin accounts can't be changed here, and a superadmin can't disable
// themselves. Clients can't change isActive themselves - see the
// users/{userId} rule in firestore.rules.

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

    if (typeof body?.isActive !== "boolean") {
      return fail("isActive (true/false) is required.", 400);
    }
    const isActive: boolean = body.isActive;

    if (uid === decoded.uid) {
      return fail("You can't change your own account.", 400);
    }

    const targetRef = adminDb.collection("users").doc(uid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      return fail("Account not found.", 404);
    }
    const targetData = targetSnap.data() || {};
    if (String(targetData.role || "").toLowerCase() === "superadmin") {
      return fail("Superadmin accounts can't be changed here.", 400);
    }

    const currentNumber = toE164(
      String(targetData.twilioNumber || targetData.assignedTwilioNumber || "")
    );

    let assignedNumber = currentNumber;
    let releasedNumber = "";

    if (!isActive) {
      // ---- Disable: release the number ----
      if (currentNumber) {
        const assignmentRef = adminDb.collection("numberAssignments").doc(currentNumber);
        const assignmentSnap = await assignmentRef.get();
        // Only delete the record if it really belongs to this account.
        if (assignmentSnap.exists && assignmentSnap.data()?.ownerUid === uid) {
          await assignmentRef.delete();
        }
        releasedNumber = currentNumber;
      }

      await targetRef.set(
        {
          isActive: false,
          twilioNumber: "",
          assignedTwilioNumber: "",
          ...(releasedNumber ? { releasedTwilioNumber: releasedNumber } : {}),
          statusUpdatedAt: FieldValue.serverTimestamp(),
          statusUpdatedBy: decoded.uid,
        },
        { merge: true }
      );
      assignedNumber = "";
    } else {
      // ---- Enable: make sure the account has a number ----
      const requested = toE164(String(body?.twilioNumber || ""));
      const wanted = requested || currentNumber;

      if (!wanted) {
        return fail("Select a Twilio number for this account.", 400);
      }
      if (!/^\+\d{8,15}$/.test(wanted)) {
        return fail("Twilio number must be a valid phone number.", 400);
      }

      const assignmentRef = adminDb.collection("numberAssignments").doc(wanted);
      const assignmentSnap = await assignmentRef.get();

      if (assignmentSnap.exists) {
        if (assignmentSnap.data()?.ownerUid !== uid) {
          return fail("That Twilio number is already assigned to another account.", 409);
        }
      } else {
        try {
          await assignmentRef.create({
            ownerUid: uid,
            phoneNumberSid: "",
            createdAt: new Date(),
          });
        } catch {
          return fail("That Twilio number is already assigned to another account.", 409);
        }
      }

      await targetRef.set(
        {
          isActive: true,
          twilioNumber: wanted,
          assignedTwilioNumber: wanted,
          releasedTwilioNumber: FieldValue.delete(),
          statusUpdatedAt: FieldValue.serverTimestamp(),
          statusUpdatedBy: decoded.uid,
        },
        { merge: true }
      );
      assignedNumber = wanted;
    }

    // Best-effort on the Auth side: an account that exists in Firestore but
    // not in Auth shouldn't make the toggle fail.
    let authUpdated = true;
    try {
      await getAuth().updateUser(uid, { disabled: !isActive });
      if (!isActive) {
        await getAuth().revokeRefreshTokens(uid);
      }
    } catch (authError) {
      authUpdated = false;
      console.error("Auth update failed for account status change", authError);
    }

    return NextResponse.json({
      ok: true,
      uid,
      isActive,
      twilioNumber: assignedNumber,
      releasedNumber,
      authUpdated,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return fail(message, 500);
  }
}
