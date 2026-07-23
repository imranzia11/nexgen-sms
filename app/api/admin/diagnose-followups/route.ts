import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../lib/phone";

// READ-ONLY diagnostic for the superadmin dashboard. Given a phone number,
// finds every conversation across every account with that phone, and dumps
// the full message timeline (including whether each outbound message was
// isFollowUp:true) plus every followUps doc tied to that conversation
// (status/skippedReason/dueAt/sentAt). Built to answer one specific
// question live: "did the automated follow-up cron actually send this
// message, and if so, did it fire after the customer had already replied?"
// No writes anywhere in this route - purely a read/inspect tool.

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing authorization token." },
        { status: 401 }
      );
    }

    const decodedUser = await getAuth().verifyIdToken(token);

    const callerSnap = await adminDb.collection("users").doc(decodedUser.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};

    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const rawPhone = req.nextUrl.searchParams.get("phone") || "";
    const phone = toE164(rawPhone);

    if (!phone) {
      return NextResponse.json(
        { ok: false, error: "Provide a phone number, e.g. +13863060228" },
        { status: 400 }
      );
    }

    const convoSnap = await adminDb
      .collection("conversations")
      .where("phone", "==", phone)
      .get();

    if (convoSnap.empty) {
      return NextResponse.json({ ok: true, phone, conversations: [] });
    }

    const conversations = await Promise.all(
      convoSnap.docs.map(async (convoDoc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const convo = convoDoc.data() || {};

        const [ownerSnap, messagesSnap, followUpsSnap] = await Promise.all([
          convo.ownerUid
            ? adminDb.collection("users").doc(String(convo.ownerUid)).get()
            : Promise.resolve(null),
          convoDoc.ref.collection("messages").orderBy("createdAt", "asc").get(),
          adminDb
            .collection("followUps")
            .where("conversationId", "==", convoDoc.id)
            .get(),
        ]);

        const ownerData = ownerSnap && ownerSnap.exists ? ownerSnap.data() || {} : {};

        const messages = messagesSnap.docs.map((m: FirebaseFirestore.QueryDocumentSnapshot) => {
          const d = m.data() || {};
          return {
            id: m.id,
            direction: String(d.direction || ""),
            body: String(d.body || ""),
            isFollowUp: d.isFollowUp === true,
            status: String(d.status || ""),
            createdAt: toIso(d.createdAt),
          };
        });

        const followUps = followUpsSnap.docs.map((f: FirebaseFirestore.QueryDocumentSnapshot) => {
          const d = f.data() || {};
          return {
            id: f.id,
            status: String(d.status || ""),
            skippedReason: d.skippedReason ? String(d.skippedReason) : null,
            followUpMessage: String(d.followUpMessage || ""),
            dueAt: toIso(d.dueAt),
            createdAt: toIso(d.createdAt),
            sentAt: toIso(d.sentAt),
            sid: d.sid ? String(d.sid) : null,
            error: d.error ? String(d.error) : null,
          };
        });

        return {
          conversationId: convoDoc.id,
          ownerUid: String(convo.ownerUid || ""),
          ownerEmail: String(ownerData.email || ""),
          ownerName: String(ownerData.name || ""),
          hasReply: convo.hasReply === true,
          lastDirection: String(convo.lastDirection || ""),
          resolved: convo.resolved === true,
          blocked: convo.blocked === true,
          messages,
          followUps,
        };
      })
    );

    return NextResponse.json({ ok: true, phone, conversations });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
