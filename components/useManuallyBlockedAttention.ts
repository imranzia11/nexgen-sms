"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { phoneDocId } from "../lib/phone";

// Same OR check the /replies list itself uses (isManualBlockRecord in
// app/replies/page.tsx) to decide whether a blocked number is a manual
// block vs. a customer's own STOP - kept identical on purpose, so this
// hook can never disagree with what the list actually shows as "Blocked".
function isManualBlockRecord(data: Record<string, any>) {
  return (
    String(data.reason || "").toLowerCase() === "manual_block" ||
    String(data.source || "").toLowerCase() === "manual_block_from_replies"
  );
}

// True only if the signed-in account has at least one manually-blocked
// number (blocked via the Block button on /replies - NOT a customer's own
// STOP opt-out) that STILL has a visible conversation on /replies.
//
// A manual block can outlive its conversation - e.g. the conversation
// record was deleted separately while the blacklist entry itself was
// deliberately left in place. In that case there's nothing to click
// through to or act on, so the mark should not light up: checking the
// blacklist alone would flag an account for something no longer visible
// anywhere, which is exactly what happened on Sunny's account after its
// manually-blocked conversations were cleaned up but their blacklist
// entries were intentionally kept.
//
// The number of manual blocks per account is small (a handful at most),
// so this does a small, targeted set of single-document lookups by ID
// (conversations/{uid}_{phone}) rather than downloading any collection.
//
// Note: the blacklist query itself downloads every "blocked" doc for the
// account (STOP opt-outs included, not just manual blocks), since a
// Firestore filter can't cleanly match "reason OR source" server-side
// without adding a new composite `or()` index - deliberately avoided
// given how much index/query trouble today already involved. blacklisted_
// numbers is normally far smaller than conversations, so this should stay
// cheap; worth revisiting only if an account ever accumulates a huge
// number of STOP entries.
export function useManuallyBlockedAttention() {
  const [hasAttention, setHasAttention] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setHasAttention(false);
        return;
      }

      try {
        // Only filter server-side on the fields that are always reliably
        // set (ownerUid, status) - "manual vs. STOP" is then decided
        // client-side with the same OR logic the list uses, instead of a
        // single-field Firestore filter that could disagree with it.
        const blacklistSnap = await getDocs(
          query(
            collection(db, "blacklisted_numbers"),
            where("ownerUid", "==", user.uid),
            where("status", "==", "blocked")
          )
        );

        if (blacklistSnap.empty) {
          if (!cancelled) setHasAttention(false);
          return;
        }

        const phones = blacklistSnap.docs
          .filter((d) => isManualBlockRecord(d.data() || {}))
          .map((d) => String(d.data()?.phone || "").trim())
          .filter(Boolean);

        if (phones.length === 0) {
          if (!cancelled) setHasAttention(false);
          return;
        }

        const existenceChecks = await Promise.all(
          phones.map(async (phone) => {
            const conversationId = `${user.uid}_${phoneDocId(phone)}`;
            const snap = await getDoc(doc(db, "conversations", conversationId));
            return snap.exists();
          })
        );

        if (!cancelled) {
          setHasAttention(existenceChecks.some(Boolean));
        }
      } catch (error) {
        console.error("Failed to load manually-blocked attention state", error);
        if (!cancelled) setHasAttention(false);
      }
    });

    return () => {
      cancelled = true;
      unsubAuth();
    };
  }, []);

  return hasAttention;
}
