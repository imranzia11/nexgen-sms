import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";

// Superadmin broadcast messages. POST creates a new one (fanned out to
// every signed-in account via the announcements collection, read by
// components/AnnouncementModal.tsx on every page); GET lists recent history
// for the superadmin's own sending page. Both are gated by the same
// caller-role check used by every other /api/admin/* route - this is the
// only place that ever writes an announcements doc, since the Firestore
// rule for that collection closes create/update/delete to clients entirely.

async function requireSuperadmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  const decodedUser = await getAuth().verifyIdToken(token);

  const callerSnap = await adminDb.collection("users").doc(decodedUser.uid).get();
  const callerData = callerSnap.exists ? callerSnap.data() || {} : {};

  if (String(callerData.role || "").toLowerCase() !== "superadmin") {
    const err = new Error("Forbidden.");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }

  return decodedUser;
}

export async function GET(req: NextRequest) {
  try {
    await requireSuperadmin(req);

    const snap = await adminDb
      .collection("announcements")
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    const announcements = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        message: String(data.message || ""),
        createdByEmail: String(data.createdByEmail || ""),
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
      };
    });

    return NextResponse.json({ ok: true, announcements });
  } catch (err: unknown) {
    const status = (err as Error & { status?: number })?.status || 500;
    const errorMessage = err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const decodedUser = await requireSuperadmin(req);

    const body = await req.json().catch(() => ({}));
    const message = String(body?.message || "").trim();

    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Message cannot be empty." },
        { status: 400 }
      );
    }
    if (message.length > 1000) {
      return NextResponse.json(
        { ok: false, error: "Message is too long (max 1000 characters)." },
        { status: 400 }
      );
    }

    const docRef = await adminDb.collection("announcements").add({
      message,
      createdBy: decodedUser.uid,
      createdByEmail: decodedUser.email || "",
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ ok: true, id: docRef.id });
  } catch (err: unknown) {
    const status = (err as Error & { status?: number })?.status || 500;
    const errorMessage = err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status });
  }
}
