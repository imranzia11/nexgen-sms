import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";

// Server-only aggregation for the superadmin dashboard. Every regular page
// in this app scopes its Firestore reads to ownerUid == the signed-in user
// (both client-side via firestore.rules, and server-side by convention in
// every other API route) - this is the one deliberate exception, gated by
// checking the CALLER's own role doc before reading anything cross-account.
// Uses the Admin SDK, which bypasses firestore.rules entirely, so the rules
// themselves are never loosened for regular client access - this route is
// the only door, and it's locked behind the role check below.

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

          const [sentSnap, blockedSnap, authUser] = await Promise.all([
            adminDb
              .collection("messages")
              .where("ownerUid", "==", uid)
              .where("direction", "==", "outbound")
              .count()
              .get(),
            adminDb
              .collection("blacklisted_numbers")
              .where("ownerUid", "==", uid)
              .where("status", "==", "blocked")
              .count()
              .get(),
            getAuth()
              .getUser(uid)
              .catch(() => null),
          ]);

          return {
            uid,
            name: String(data.name || ""),
            email: String(data.email || ""),
            isActive: data.isActive === true,
            twilioNumber: String(
              data.twilioNumber || data.assignedTwilioNumber || ""
            ),
            smsSentCount: sentSnap.data().count,
            blockedCount: blockedSnap.data().count,
            lastLoginAt: authUser?.metadata.lastSignInTime || null,
            createdAt: authUser?.metadata.creationTime || null,
          };
        })
    );

    accounts.sort((a, b) => a.email.localeCompare(b.email));

    const totals = {
      totalAccounts: accounts.length,
      totalSmsSent: accounts.reduce((sum, a) => sum + a.smsSentCount, 0),
      totalBlocked: accounts.reduce((sum, a) => sum + a.blockedCount, 0),
    };

    return NextResponse.json({ ok: true, accounts, totals });
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
