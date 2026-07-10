"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

// True if the signed-in account has at least one manually-blocked number
// (blocked via the Block button on /replies - NOT a customer's own STOP
// opt-out). Powers a small yellow "needs attention" mark on the Replies
// nav card, entirely separate from the red "Customer Replied" count badge
// - this never affects that number, it's just an extra visual signal that
// something needs a human decision (unblock, or leave it).
//
// Uses a single count() aggregation query (same pattern as
// useRepliedCount) rather than downloading any documents.
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
        const snap = await getCountFromServer(
          query(
            collection(db, "blacklisted_numbers"),
            where("ownerUid", "==", user.uid),
            where("status", "==", "blocked"),
            where("reason", "==", "manual_block")
          )
        );

        if (!cancelled) {
          setHasAttention(snap.data().count > 0);
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
