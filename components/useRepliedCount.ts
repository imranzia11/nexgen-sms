"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

function phoneKey(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

// Live count of conversations where the customer's most recent message is a
// reply we haven't sent a follow-up to yet (mirrors the "Customer Replied"
// tab/stat on /replies: !pinned && hasReply && lastDirection === "inbound",
// with blacklisted/opted-out numbers excluded — same as the real page).
// Powers the notification badge on the "Replies" nav card across pages.
export function useRepliedCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let unsubConversations: (() => void) | null = null;
    let unsubBlacklist: (() => void) | null = null;

    // Latest snapshot data kept in refs-via-closure state so either listener
    // (conversations or blacklist) can recompute the count as soon as new
    // data comes in, without waiting on the other one.
    let latestConvoDocs: Array<Record<string, any>> = [];
    let blockedPhones = new Set<string>();

    function recompute() {
      let repliedCount = 0;

      for (const data of latestConvoDocs) {
        const phone = phoneKey(
          data.phone || data.customerPhone || data.to || data.contactPhone
        );
        if (phone && blockedPhones.has(phone)) continue;

        const lastDirection = String(data.lastDirection || data.direction || "")
          .trim()
          .toLowerCase();

        if (
          data.pinned !== true &&
          data.hasReply === true &&
          lastDirection === "inbound"
        ) {
          repliedCount += 1;
        }
      }

      setCount(repliedCount);
    }

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubConversations) {
        unsubConversations();
        unsubConversations = null;
      }
      if (unsubBlacklist) {
        unsubBlacklist();
        unsubBlacklist = null;
      }

      latestConvoDocs = [];
      blockedPhones = new Set<string>();

      if (!user) {
        setCount(0);
        return;
      }

      unsubBlacklist = onSnapshot(
        query(
          collection(db, "blacklisted_numbers"),
          where("ownerUid", "==", user.uid)
        ),
        (snap) => {
          const next = new Set<string>();
          snap.forEach((docSnap) => {
            const data = docSnap.data() || {};
            if (String(data.status || "").toLowerCase() === "blocked") {
              const phone = phoneKey(data.phone);
              if (phone) next.add(phone);
            }
          });
          blockedPhones = next;
          recompute();
        },
        () => {
          blockedPhones = new Set<string>();
          recompute();
        }
      );

      unsubConversations = onSnapshot(
        query(collection(db, "conversations"), where("ownerUid", "==", user.uid)),
        (snap) => {
          latestConvoDocs = snap.docs.map((docSnap) => docSnap.data() || {});
          recompute();
        },
        () => {
          latestConvoDocs = [];
          recompute();
        }
      );
    });

    return () => {
      unsubAuth();
      if (unsubConversations) unsubConversations();
      if (unsubBlacklist) unsubBlacklist();
    };
  }, []);

  return count;
}
