import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../lib/phone";

// Superadmin-only: create a portal account with just the fields the app
// actually needs - name, login email, password, and the Twilio number the
// account sends/receives on. The superadmin picks the password and hands the
// credentials over; nothing is emailed.
//
// Creates, in order:
//  1. the Firebase Auth login (email + password)
//  2. numberAssignments/{e164} - the uniqueness record the inbound webhook
//     routes by (create() fails if another account already owns the number,
//     which is what stops two accounts sharing one number)
//  3. users/{uid} - role "user", isActive true
// If a later step fails, the earlier ones are rolled back so a half-created
// account can't be left behind.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return getAuth().verifyIdToken(token);
}

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  let createdUid = "";

  try {
    const decoded = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decoded.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};
    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return fail("Forbidden.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const twilioNumber = toE164(String(body?.twilioNumber || ""));

    if (!name) return fail("Name is required.", 400);
    if (!EMAIL_RE.test(email)) return fail("A valid email is required.", 400);
    if (password.length < 8) return fail("Password must be at least 8 characters.", 400);
    if (!/^\+\d{8,15}$/.test(twilioNumber)) {
      return fail("Twilio number must be a valid phone number, e.g. +14234019888.", 400);
    }

    // Cheap pre-check so the common "number already taken" case fails before
    // an Auth user is created. The create() below is the real guard.
    const assignmentRef = adminDb.collection("numberAssignments").doc(twilioNumber);
    if ((await assignmentRef.get()).exists) {
      return fail("That Twilio number is already assigned to another account.", 409);
    }

    // Also refuse a number still sitting on an ACTIVE account's doc (e.g. an
    // account created before numberAssignments existed).
    const holder = await adminDb
      .collection("users")
      .where("twilioNumber", "==", twilioNumber)
      .where("isActive", "==", true)
      .limit(1)
      .get();
    if (!holder.empty) {
      return fail("That Twilio number is already assigned to another account.", 409);
    }

    try {
      const authUser = await getAuth().createUser({
        email,
        password,
        displayName: name,
        disabled: false,
      });
      createdUid = authUser.uid;
    } catch (authError: unknown) {
      const code = (authError as { code?: string })?.code;
      if (code === "auth/email-already-exists") {
        return fail("An account with that email already exists.", 409);
      }
      if (code === "auth/invalid-password") {
        return fail("Password must be at least 8 characters.", 400);
      }
      throw authError;
    }

    try {
      await assignmentRef.create({
        ownerUid: createdUid,
        phoneNumberSid: "",
        createdAt: new Date(),
      });
    } catch {
      await getAuth().deleteUser(createdUid).catch(() => {});
      return fail("That Twilio number is already assigned to another account.", 409);
    }

    try {
      await adminDb.collection("users").doc(createdUid).set({
        email,
        name,
        role: "user",
        isActive: true,
        twilioNumber,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: decoded.uid,
      });
    } catch (dbError) {
      await assignmentRef.delete().catch(() => {});
      await getAuth().deleteUser(createdUid).catch(() => {});
      throw dbError;
    }

    return NextResponse.json({
      ok: true,
      account: {
        uid: createdUid,
        name,
        email,
        isActive: true,
        twilioNumber,
        smsSentCount: 0,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error("Create account failed", error);
    return fail(message, 500);
  }
}
