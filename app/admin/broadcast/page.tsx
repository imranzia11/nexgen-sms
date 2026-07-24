"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import LoadingScreen from "../../../components/LoadingScreen";

type AnnouncementRow = {
  id: string;
  message: string;
  createdByEmail: string;
  createdAt: number | null;
};

function formatSentAt(millis: number | null) {
  if (!millis) return "just now";
  return new Date(millis).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function BroadcastPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sendSuccess, setSendSuccess] = useState("");
  const [history, setHistory] = useState<AnnouncementRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));

        if (!snap.exists() || snap.data().isActive !== true) {
          await signOut(auth).catch(() => {});
          router.push("/login");
          return;
        }

        if (String(snap.data().role || "").toLowerCase() !== "superadmin") {
          router.push("/dashboard");
          return;
        }

        setChecking(false);
        await loadHistory();
      } catch (error: unknown) {
        setHistoryError(
          error instanceof Error ? error.message : "Unexpected error."
        );
        setChecking(false);
        setHistoryLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/admin/announcements", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setHistoryError(body.error || "Failed to load history.");
      } else {
        setHistory(body.announcements || []);
      }
    } catch (error: unknown) {
      setHistoryError(
        error instanceof Error ? error.message : "Failed to load history."
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSend = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;

    setSending(true);
    setSendError("");
    setSendSuccess("");

    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ message: trimmed }),
      });
      const body = await res.json();

      if (!res.ok || !body.ok) {
        setSendError(body.error || "Failed to send update.");
        return;
      }

      setMessage("");
      setSendSuccess("Sent — it will appear on every user's screen within a few seconds.");
      await loadHistory();
    } catch (error: unknown) {
      setSendError(
        error instanceof Error ? error.message : "Failed to send update."
      );
    } finally {
      setSending(false);
    }
  };

  if (checking) {
    return <LoadingScreen text="Checking access..." />;
  }

  return (
    <main style={pageStyle}>
      <div style={heroStyle}>
        <div style={heroTopRowStyle}>
          <div>
            <div style={heroBadgeStyle}>SUPERADMIN</div>
            <h1 style={heroTitleStyle}>Send Update</h1>
            <p style={heroSubStyle}>
              Pushed instantly as a popup on every signed-in user&rsquo;s
              screen - they press OK to dismiss it.
            </p>
          </div>
          <Link href="/admin" style={backLinkStyle}>
            &larr; All Accounts
          </Link>
        </div>
      </div>

      <div style={contentStyle}>
        <div style={composeCardStyle}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. There was an update done in the last 5 minutes - if anything looks off, refresh the page."
            style={textareaStyle}
            maxLength={1000}
            rows={4}
          />
          <div style={composeFooterStyle}>
            <span style={charCountStyle}>{message.length}/1000</span>
            <button
              style={{
                ...sendButtonStyle,
                ...(sending || !message.trim() ? sendButtonDisabledStyle : {}),
              }}
              onClick={handleSend}
              disabled={sending || !message.trim()}
            >
              {sending ? "Sending..." : "Send to all users"}
            </button>
          </div>
          {sendError ? <div style={errorTextStyle}>{sendError}</div> : null}
          {sendSuccess ? <div style={successTextStyle}>{sendSuccess}</div> : null}
        </div>

        <div style={historyCardStyle}>
          <div style={historyTitleStyle}>Recent updates</div>
          {historyLoading ? (
            <div style={emptyStateStyle}>Loading...</div>
          ) : historyError ? (
            <div style={errorTextStyle}>{historyError}</div>
          ) : history.length === 0 ? (
            <div style={emptyStateStyle}>Nothing sent yet.</div>
          ) : (
            <div style={historyListStyle}>
              {history.map((row) => (
                <div key={row.id} style={historyRowStyle}>
                  <div style={historyMessageStyle}>{row.message}</div>
                  <div style={historyMetaStyle}>
                    {formatSentAt(row.createdAt)}
                    {row.createdByEmail ? ` · ${row.createdByEmail}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#f4fbf9",
  paddingBottom: 60,
};

const heroStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  borderRadius: "0 0 32px 32px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 30px 80px rgba(13, 148, 136, 0.28)",
  padding: "40px 48px",
};

const heroTopRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 20,
  flexWrap: "wrap",
};

const heroBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  width: "fit-content",
  borderRadius: 999,
  padding: "8px 14px",
  background: "rgba(255,255,255,0.14)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.4,
};

const heroTitleStyle: CSSProperties = {
  margin: "14px 0 0 0",
  fontSize: 34,
  fontWeight: 800,
  color: "#ffffff",
};

const heroSubStyle: CSSProperties = {
  margin: "8px 0 0 0",
  fontSize: 15,
  color: "rgba(236, 254, 255, 0.8)",
  maxWidth: 460,
};

const backLinkStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.28)",
  background: "rgba(255,255,255,0.08)",
  color: "#ecfeff",
  borderRadius: 999,
  padding: "10px 18px",
  fontSize: 13.5,
  fontWeight: 700,
  textDecoration: "none",
};

const contentStyle: CSSProperties = {
  maxWidth: 720,
  margin: "36px auto 0",
  padding: "0 24px",
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const composeCardStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 20,
  border: "1px solid #e2ede9",
  padding: "22px 24px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.06)",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  border: "1px solid #dbe7e3",
  borderRadius: 14,
  padding: "14px 16px",
  fontSize: 14.5,
  fontFamily: "inherit",
  color: "#0f172a",
  resize: "vertical",
  boxSizing: "border-box",
};

const composeFooterStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const charCountStyle: CSSProperties = {
  fontSize: 12,
  color: "#94a3b8",
};

const sendButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "11px 22px",
  background: "#0d9488",
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const sendButtonDisabledStyle: CSSProperties = {
  background: "#a7d3cd",
  cursor: "not-allowed",
};

const errorTextStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 13.5,
  color: "#b91c1c",
};

const successTextStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 13.5,
  color: "#047857",
  fontWeight: 600,
};

const historyCardStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 20,
  border: "1px solid #e2ede9",
  padding: "22px 24px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.06)",
};

const historyTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#0f172a",
  marginBottom: 14,
};

const historyListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const historyRowStyle: CSSProperties = {
  paddingBottom: 14,
  borderBottom: "1px solid #eef2f1",
};

const historyMessageStyle: CSSProperties = {
  fontSize: 14,
  color: "#0f172a",
  whiteSpace: "pre-wrap",
};

const historyMetaStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: "#94a3b8",
};

const emptyStateStyle: CSSProperties = {
  padding: "20px 0",
  textAlign: "center",
  color: "#64748b",
  fontSize: 14,
};
