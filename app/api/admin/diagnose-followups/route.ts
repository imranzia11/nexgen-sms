import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164, phoneDocId } from "../../../../lib/phone";

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
    // Optional: scope the whole lookup to one account. Much faster and
    // fully sufficient once you know which account owns the number - skips
    // every cross-account fallback below entirely.
    const ownerUidFilter = (req.nextUrl.searchParams.get("ownerUid") || "").trim();

    if (!phone) {
      return NextResponse.json(
        { ok: false, error: "Provide a phone number, e.g. +13863060228" },
        { status: 400 }
      );
    }

    // Two lookup strategies, merged: (1) a where("phone","==") query, which
    // only finds a conversation if that field was ever backfilled/written in
    // exactly this E.164 form, and (2) deriving the exact doc ID directly
    // (`${ownerUid}_${phoneDocId(phone)}`) for every account and batch-
    // fetching those IDs - this is the SAME id-construction the inbound
    // webhook itself uses (buildConversationId), so it finds the doc even if
    // its "phone" field is missing, stale, or differently formatted, which
    // this codebase has hit before (e.g. the twilioNumber trailing-space
    // bug). Deduped by doc ID below.
    const phoneFieldQuery = ownerUidFilter
      ? adminDb
          .collection("conversations")
          .where("phone", "==", phone)
          .where("ownerUid", "==", ownerUidFilter)
      : adminDb.collection("conversations").where("phone", "==", phone);

    const [phoneFieldSnap, usersSnap] = await Promise.all([
      phoneFieldQuery.get(),
      ownerUidFilter ? Promise.resolve(null) : adminDb.collection("users").get(),
    ]);

    const candidateOwnerUids = ownerUidFilter
      ? [ownerUidFilter]
      : (usersSnap?.docs || []).map((userDoc) => userDoc.id);

    const targetDocId = phoneDocId(phone);
    const candidateRefs = candidateOwnerUids.map((uid) =>
      adminDb.collection("conversations").doc(`${uid}_${targetDocId}`)
    );

    const candidateSnaps = candidateRefs.length
      ? await adminDb.getAll(...candidateRefs)
      : [];

    const byId = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    phoneFieldSnap.docs.forEach((d) => byId.set(d.id, d));
    candidateSnaps.forEach((d) => {
      if (d.exists) byId.set(d.id, d);
    });

    let convoDocs = Array.from(byId.values());
    let scannedFallback = false;
    let scannedCount = 0;

    // LAST RESORT: both targeted strategies above came up empty even though
    // the conversation is visibly reachable in the normal UI - meaning its
    // stored "phone" field AND its document ID both diverge from what every
    // other page in the app expects for this number. Rather than guess at
    // yet another format, pull EVERY conversation for EVERY account (scoped
    // per-owner via the equality-only ownerUid filter, no new index needed,
    // no limit - a single flat collection().limit(20000).get() across all
    // accounts combined silently truncated before reaching this account's
    // docs on a platform with 20000+ total conversations) and match in
    // memory on the last 10 digits, which survives any missing "+", missing
    // country code, stray formatting, etc. This also surfaces the ACTUAL
    // stored phone/id so we can see exactly how it diverged.
    if (convoDocs.length === 0) {
      scannedFallback = true;
      const last10 = phone.replace(/\D/g, "").slice(-10);

      const perOwnerSnaps = await Promise.all(
        candidateOwnerUids.map((uid) =>
          adminDb
            .collection("conversations")
            .where("ownerUid", "==", uid)
            .limit(50000) // safety ceiling only, not expected to bind
            .get()
        )
      );

      const allDocs = perOwnerSnaps.flatMap((snap) => snap.docs);
      scannedCount = allDocs.length;

      convoDocs = allDocs.filter((d) => {
        const data = d.data() || {};
        const storedPhoneDigits = String(data.phone || "").replace(/\D/g, "");
        const idDigits = d.id.replace(/\D/g, "");
        return (
          (last10.length === 10 && storedPhoneDigits.endsWith(last10)) ||
          (last10.length === 10 && idDigits.endsWith(last10))
        );
      });

      // STILL nothing? The per-owner scan above only covers ownerUids that
      // currently have a doc in "users" - if this conversation's owner
      // account was ever removed/deleted from "users" (this platform has a
      // real history of account-data inconsistencies - see the duplicate-
      // twilioNumber and cross-account-leak fixes elsewhere in this repo),
      // its conversations would be invisible to that approach entirely.
      // This tier ignores "users" completely and paginates through the
      // WHOLE "conversations" collection via a documentId cursor (no
      // arbitrary cap, no reliance on any other collection), so it will
      // find the doc even if its owner account no longer exists anywhere
      // else in the system. Skipped when scoped to one account - a single
      // where(ownerUid==) query is already exhaustive for that account, so
      // there's nothing a whole-platform scan would add.
      if (convoDocs.length === 0 && !ownerUidFilter) {
        let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
        const PAGE_SIZE = 5000;
        let fullScanCount = 0;

        for (;;) {
          let pageQuery = adminDb
            .collection("conversations")
            .orderBy(FieldPath.documentId())
            .limit(PAGE_SIZE);
          if (cursor) pageQuery = pageQuery.startAfter(cursor);

          const pageSnap = await pageQuery.get();
          if (pageSnap.empty) break;

          fullScanCount += pageSnap.size;

          pageSnap.docs.forEach((d) => {
            const data = d.data() || {};
            const storedPhoneDigits = String(data.phone || "").replace(/\D/g, "");
            const idDigits = d.id.replace(/\D/g, "");
            if (
              (last10.length === 10 && storedPhoneDigits.endsWith(last10)) ||
              (last10.length === 10 && idDigits.endsWith(last10))
            ) {
              convoDocs.push(d);
            }
          });

          cursor = pageSnap.docs[pageSnap.docs.length - 1];
          if (pageSnap.size < PAGE_SIZE) break;
        }

        scannedCount = fullScanCount;
      }
    }

    if (convoDocs.length === 0) {
      return NextResponse.json({
        ok: true,
        phone,
        conversations: [],
        scannedFallback,
        scannedCount,
      });
    }

    const conversations = await Promise.all(
      convoDocs.map(async (convoDoc: FirebaseFirestore.DocumentSnapshot) => {
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
          storedPhone: String(convo.phone || ""),
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

    return NextResponse.json({
      ok: true,
      phone,
      conversations,
      scannedFallback,
      scannedCount,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
