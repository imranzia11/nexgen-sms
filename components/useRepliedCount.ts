"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

// Live count of conversations where the customer's most recent message is a
// reply we haven't sent a follow-up to yet (mirrors the "Customer Replied"
// tab/stat on /replies: !pinned && hasReply && lastDirection === "inbound").
// Powers the notification badge on the "Replies" nav card across pages.
export function useRepliedCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let unsubConversations: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubConversations) {
        unsubConversations();
        unsubConversations = null;
      }

      if (!user) {
        setCount(0);
        return;
      }

      unsubConversations = onSnapshot(
        query(collection(db, "conversations"), where("ownerUid", "==", user.uid)),
        (snap) => {
          let repliedCount = 0;

          snap.forEach((docSnap) => {
            const data = docSnap.data() || {};
            const lastDirection = String(
              data.lastDirection || data.direction || ""
            )
              .trim()
              .toLowerCase();

            if (
              data.pinned !== true &&
              data.hasReply === true &&
              lastDirection === "inbound"
            ) {
              repliedCount += 1;
            }
          });

          setCount(repliedCount);
        },
        () => setCount(0)
      );
    });

    return () => {
      unsubAuth();
      if (unsubConversations) unsubConversations();
    };
  }, []);

  return count;
}
