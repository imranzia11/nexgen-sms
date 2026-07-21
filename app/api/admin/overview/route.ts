import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";

// Server-only roster for the superadmin dashboard. Every regular page in
// this app scopes its Firestore reads to ownerUid == the signed-in user
// (both client-side via firestore.rules, and server-side by convention in
// every other API route) - this is the one deliberate exception, gated by
// checking the CALLER's own role doc before reading anything cross-account.
// Uses the Admin SDK, which bypasses firestore.rules entirely, so the rules
// themselves are never loosened for regular client access - this route is
// the only door, and it's locked behind the role check below.
//
// Deliberately thin: just enough per account to render a clickable roster
// (name/email/status/total SMS sent). Login history and the same SMS count
// broken out again live in /api/admin/account/[uid] for the detail view,
// so this list stays a single cheap query per account instead of also
// paying for a loginHistory read nobody's looking at yet.

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new Error("Missing authorization token.");
  }

  return getAuth().verifyIdToken(token);
}

export async function GET(req: NextRequest) {
  try {
    const decodedUser = await getUserFromRequest(req);

    const callerSnap = await adminDb.collection("users").doc(decodedUser.uid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};

    if (String(callerData.role || "").toLowerCase() !== "superadmin") {
      return NextResponse.json(
        { ok: false, error: "Forbidden." },
        { status: 403 }
      );
    }

    const usersSnap = await adminDb.collection("users").get();

    const accounts = await Promise.all(
      usersSnap.docs
        .filter((userDoc) => String(userDoc.data()?.role || "").toLowerCase() !== "superadmin")
        .map(async (userDoc) => {
          const uid = userDoc.id;
          const data = userDoc.data() || {};

          // Two sources, summed: the root `messages` collection covers
          // every regular send and manual reply, but the follow-up cron
          // (app/api/cron/send-followups/route.ts) only ever logs a sent
          // follow-up into the conversation's messages SUBcollection, never
          // this root one - so a follow-up-only send would otherwise be
          // invisible here. followUps (status=="sent") fills that gap.
          // Both queries are equality-only filters, so neither needs a new
          // composite index.
          const [sentSnap, followUpSentSnap] = await Promise.all([
            adminDb
              .collection("messages")
              .where("ownerUid", "==", uid)
              .where("direction", "==", "outbound")
              .count()
              .get(),
            adminDb
              .collection("followUps")
              .where("ownerUid", "==", uid)
              .where("status", "==", "sent")
              .count()
              .get(),
          ]);

          return {
            uid,
            name: String(data.name || ""),
            email: String(data.email || ""),
            isActive: data.isActive === true,
            twilioNumber: String(
              data.twilioNumber || data.assignedTwilioNumber || ""
            ),
            smsSentCount: sentSnap.data().count + followUpSentSnap.data().count,
          };
        })
    );

    accounts.sort((a, b) => a.email.localeCompare(b.email));

    return NextResponse.json({ ok: true, accounts });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
