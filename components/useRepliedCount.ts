"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

// Live-ish count of conversations where the customer's most recent message
// is a reply we haven't followed up on yet (mirrors the "Customer Replied"
// stat on /replies: !pinned && hasReply && lastDirection === "inbound").
// Powers the notification badge on the "Replies" nav card across pages.
//
// This used to keep a permanent onSnapshot listener open on the entire
// conversations collection (plus a second one on blacklisted_numbers, to
// cross-check which numbers to exclude) just to compute one number - on an
// account with tens of thousands of conversations, that meant downloading
// everything on every single page load. It now uses a single Firestore
// count() aggregation query, which returns just an integer without
// downloading any documents, and refreshes on mount / sign-in instead of
// staying open as a live listener. The trade-off: the badge no longer
// ticks up the instant a reply arrives while you're already looking at a
// page - it refreshes on your next page load or navigation instead.
export function useRepliedCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setCount(0);
        return;
      }

      try {
        const col = collection(db, "conversations");
        const base = [
          where("ownerUid", "==", user.uid),
          where("blocked", "==", false),
        ];

        const countQuery = async (...extra: ReturnType<typeof where>[]) => {
          const snap = await getCountFromServer(query(col, ...base, ...extra));
          return snap.data().count;
        };

        const [raw, pinnedOverlap] = await Promise.all([
          countQuery(
            where("hasReply", "==", true),
            where("lastDirection", "==", "inbound")
          ),
          countQuery(
            where("pinned", "==", true),
            where("hasReply", "==", true),
            where("lastDirection", "==", "inbound")
          ),
        ]);

        if (!cancelled) {
          setCount(Math.max(0, raw - pinnedOverlap));
        }
      } catch (error) {
        console.error("Failed to load replied count", error);
        if (!cancelled) setCount(0);
      }
    });

    return () => {
      cancelled = true;
      unsubAuth();
    };
  }, []);

  return count;
}
