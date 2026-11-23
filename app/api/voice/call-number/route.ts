import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../lib/phone";
import { HttpError, listFreeNumbers, setCallNumber } from "../../../../lib/callNumber";

// Account holders choose the number their own calls are placed from.
// The text number is never changed here.
//
// GET  -> { enabled, textNumber, callNumber, dialsFrom, available[] }
// POST { callNumber } ("" = use the text number)

async function requireAccount(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new HttpError("Missing authorization token.", 401);
  const decoded = await getAuth().verifyIdToken(token);
  const snap = await adminDb.collection("users").doc(decoded.uid).get();
  const user = snap.exists ? snap.data() || {} : {};
  return { uid: decoded.uid, user };
}

function fail(error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireAccount(req);
    const textNumber = toE164(String(user.twilioNumber || user.assignedTwilioNumber || ""));
    const callNumber = toE164(String(user.callNumber || ""));
    const enabled = user.isActive === true && user.voiceEnabled === true;
    const available = enabled ? await listFreeNumbers() : [];
    return NextResponse.json({
      ok: true,
      enabled,
      textNumber,
      callNumber,
      dialsFrom: callNumber || textNumber,
      available,
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { uid, user } = await requireAccount(req);
    if (user.isActive !== true || user.voiceEnabled !== true) {
      throw new HttpError("Calling is not enabled for this account.", 403);
    }
    const body = await req.json().catch(() => ({}));
    const result = await setCallNumber(uid, String(body?.callNumber || ""), uid);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
}
