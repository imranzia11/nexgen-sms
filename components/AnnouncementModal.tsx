"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query, limit } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

// Rendered once, globally, from app/layout.tsx - not tied to any one page.
// Superadmin pushes a message via /admin/broadcast -> POST
// /api/admin/announcements -> new doc in the `announcements` collection.
// Every signed-in browser has a live onSnapshot on the latest doc (Firestore
// rules let any signed-in user READ this collection, but only the Admin SDK
// can write it - see firestore.rules), so the popup appears within a
// second or two of it being sent, no polling needed.
//
// "Seen it" is tracked in localStorage, keyed by uid - scoped per SIGNED-IN
// ACCOUNT, not just per browser. Without the uid in the key, dismissing an
// announcement while signed in as one account would also suppress it for
// the next account signed into that same browser (e.g. testing as
// superadmin, then logging into a rep's account to check) - each account
// needs its own "have I seen this one" flag. This does NOT give the
// superadmin a read receipt of who's acknowledged what; that would need a
// second write path (and a rules change letting each user write their own
// ack) and hasn't been asked for.
const ACK_STORAGE_PREFIX = "nexgen_last_acked_announcement_";

type Announcement = {
  id: string;
  message: string;
  createdAtMillis: number | null;
};

export default function AnnouncementModal() {
  const [uid, setUid] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      setUid(user ? user.uid : null);
      if (!user) {
        setVisible(false);
        setAnnouncement(null);
      }
    });
    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!uid) return;

    const q = query(
      collection(db, "announcements"),
      orderBy("createdAt", "desc"),
      limit(1)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        if (snap.empty) return;
        const doc = snap.docs[0];
        const data = doc.data();

        const latest: Announcement = {
          id: doc.id,
          message: String(data.message || ""),
          createdAtMillis:
            data.createdAt && typeof data.createdAt.toMillis === "function"
              ? data.createdAt.toMillis()
              : null,
        };

        let lastAcked = "";
        try {
          lastAcked = window.localStorage.getItem(ACK_STORAGE_PREFIX + uid) || "";
        } catch {
          // localStorage unavailable (private browsing, etc) - just show it
          // every load in that case rather than crash.
        }

        if (latest.id !== lastAcked && latest.message) {
          setAnnouncement(latest);
          setVisible(true);
        }
      },
      (error) => {
        // Logged (not surfaced as a UI banner) - most likely cause is the
        // `announcements` Firestore rule not being deployed yet, which
        // shows up here as permission-denied.
        console.error("[AnnouncementModal] listen failed:", error);
      }
    );

    return () => unsub();
  }, [uid]);

  const handleOk = () => {
    if (announcement && uid) {
      try {
        window.localStorage.setItem(ACK_STORAGE_PREFIX + uid, announcement.id);
      } catch {
        // Ignore - worst case it shows again next load.
      }
    }
    setVisible(false);
  };

  if (!visible || !announcement) return null;

  const timeLabel = announcement.createdAtMillis
    ? new Date(announcement.createdAtMillis).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <div style={badgeStyle}>UPDATE</div>
        <div style={messageStyle}>{announcement.message}</div>
        {timeLabel ? <div style={timeStyle}>{timeLabel}</div> : null}
        <button style={okButtonStyle} onClick={handleOk} autoFocus>
          OK
        </button>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
  padding: 20,
};

const cardStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 20,
  padding: "28px 26px",
  maxWidth: 380,
  width: "100%",
  boxShadow: "0 30px 80px rgba(0,0,0,0.28)",
  textAlign: "center",
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "5px 12px",
  borderRadius: 999,
  background: "rgba(13, 148, 136, 0.12)",
  color: "#0f766e",
  fontSize: 11.5,
  fontWeight: 800,
  letterSpacing: 0.6,
};

const messageStyle: CSSProperties = {
  marginTop: 16,
  fontSize: 15.5,
  lineHeight: 1.5,
  color: "#0f172a",
  whiteSpace: "pre-wrap",
};

const timeStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  color: "#94a3b8",
};

const okButtonStyle: CSSProperties = {
  marginTop: 22,
  width: "100%",
  padding: "12px 0",
  borderRadius: 12,
  border: "none",
  background: "#0d9488",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
};
