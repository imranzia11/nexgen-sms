"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import LoadingScreen from "../../../components/LoadingScreen";

type MessageRow = {
  id: string;
  direction: string;
  body: string;
  isFollowUp: boolean;
  status: string;
  createdAt: string | null;
};

type FollowUpRow = {
  id: string;
  status: string;
  skippedReason: string | null;
  followUpMessage: string;
  dueAt: string | null;
  createdAt: string | null;
  sentAt: string | null;
  sid: string | null;
  error: string | null;
};

type ConversationResult = {
  conversationId: string;
  storedPhone: string;
  ownerUid: string;
  ownerEmail: string;
  ownerName: string;
  hasReply: boolean;
  lastDirection: string;
  resolved: boolean;
  blocked: boolean;
  messages: MessageRow[];
  followUps: FollowUpRow[];
};

function fmt(value: string | null): string {
  if (!value) return "(none)";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "(none)";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function DiagnoseFollowUpsPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ConversationResult[] | null>(null);
  const [scanInfo, setScanInfo] = useState<{ scannedFallback: boolean; scannedCount: number } | null>(null);

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

        const data = snap.data();

        if (String(data.role || "").toLowerCase() !== "superadmin") {
          router.push("/dashboard");
          return;
        }

        setChecking(false);
      } catch {
        setChecking(false);
      }
    });

    return () => unsub();
  }, [router]);

  async function handleLookup() {
    if (!phone.trim()) return;

    setLoading(true);
    setError("");
    setResults(null);

    try {
      const user = auth.currentUser;
      if (!user) {
        router.push("/login");
        return;
      }

      const idToken = await user.getIdToken();
      const res = await fetch(
        `/api/admin/diagnose-followups?phone=${encodeURIComponent(phone.trim())}`,
        { headers: { Authorization: `Bearer ${idToken}` } }
      );
      const body = await res.json();

      if (!res.ok || !body.ok) {
        setError(body.error || "Lookup failed.");
        setLoading(false);
        return;
      }

      setResults(body.conversations || []);
      setScanInfo({
        scannedFallback: body.scannedFallback === true,
        scannedCount: Number(body.scannedCount || 0),
      });
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
      setLoading(false);
    }
  }

  if (checking) {
    return <LoadingScreen text="Checking account access..." />;
  }

  return (
    <main style={pageStyle}>
      <div style={heroStyle}>
        <Link href="/admin" style={backLinkStyle}>
          &lsaquo; All Accounts
        </Link>
        <h1 style={heroTitleStyle}>Diagnose Follow-Ups</h1>
        <p style={heroSubStyle}>
          Read-only. Look up a phone number to see the exact message timeline
          and every followUps doc tied to it - whether each outbound message
          was the automated follow-up, and whether it fired before or after a
          customer reply.
        </p>
      </div>

      <div style={contentStyle}>
        <div style={searchRowStyle}>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleLookup();
            }}
            placeholder="+13863060228"
            style={inputStyle}
          />
          <button
            onClick={handleLookup}
            disabled={loading || !phone.trim()}
            style={{
              ...lookupButtonStyle,
              ...(loading || !phone.trim() ? lookupButtonDisabledStyle : null),
            }}
          >
            {loading ? "Looking up..." : "Look up"}
          </button>
        </div>

        {error ? <div style={errorStateStyle}>{error}</div> : null}

        {results && results.length === 0 ? (
          <div style={emptyStateStyle}>
            No conversation found for that phone number.
            {scanInfo?.scannedFallback ? (
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                Scanned all {scanInfo.scannedCount} conversation docs across
                every account for a last-10-digit match and still found
                nothing - this number genuinely doesn&apos;t exist in the
                conversations collection under any format.
              </div>
            ) : null}
          </div>
        ) : null}

        {results && results.length > 0 && scanInfo?.scannedFallback ? (
          <div style={scanNoticeStyle}>
            Found via fallback scan ({scanInfo.scannedCount} docs checked) -
            this record didn&apos;t match the standard phone field or ID
            format, see &quot;stored phone&quot; below for the actual value.
          </div>
        ) : null}

        {results?.map((convo) => (
          <div key={convo.conversationId} style={panelStyle}>
            <div style={convoHeaderStyle}>
              <div>
                <div style={convoOwnerStyle}>
                  {convo.ownerName || "(no name)"} &middot; {convo.ownerEmail}
                </div>
                <div style={convoIdStyle}>{convo.conversationId}</div>
                <div style={convoIdStyle}>
                  stored phone: &quot;{convo.storedPhone}&quot;
                </div>
              </div>
              <div style={badgeRowStyle}>
                <span
                  style={{
                    ...badgeStyle,
                    ...(convo.hasReply ? badgeGreenStyle : badgeGrayStyle),
                  }}
                >
                  hasReply: {String(convo.hasReply)}
                </span>
                <span
                  style={{
                    ...badgeStyle,
                    ...(convo.resolved ? badgeGrayStyle : badgeGreenStyle),
                  }}
                >
                  resolved: {String(convo.resolved)}
                </span>
                <span
                  style={{
                    ...badgeStyle,
                    ...(convo.blocked ? badgeRedStyle : badgeGrayStyle),
                  }}
                >
                  blocked: {String(convo.blocked)}
                </span>
              </div>
            </div>

            <div style={sectionLabelStyle}>Message timeline</div>
            <div style={timelineStyle}>
              {convo.messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    ...messageRowStyle,
                    ...(m.direction === "inbound"
                      ? messageInboundStyle
                      : messageOutboundStyle),
                  }}
                >
                  <div style={messageMetaStyle}>
                    <span style={messageDirectionStyle}>
                      {m.direction || "?"}
                    </span>
                    {m.isFollowUp ? (
                      <span style={followUpTagStyle}>AUTOMATED FOLLOW-UP</span>
                    ) : null}
                    <span style={messageStatusStyle}>{m.status}</span>
                    <span style={messageTimeStyle}>{fmt(m.createdAt)}</span>
                  </div>
                  <div style={messageBodyStyle}>{m.body || "(no text)"}</div>
                </div>
              ))}
            </div>

            <div style={sectionLabelStyle}>followUps docs</div>
            {convo.followUps.length === 0 ? (
              <div style={emptyStateStyle}>
                No followUps docs reference this conversation.
              </div>
            ) : (
              <div style={followUpListStyle}>
                {convo.followUps.map((f) => (
                  <div key={f.id} style={followUpCardStyle}>
                    <div style={followUpStatusRowStyle}>
                      <span
                        style={{
                          ...badgeStyle,
                          ...(f.status === "sent"
                            ? badgeGreenStyle
                            : f.status === "skipped"
                              ? badgeGrayStyle
                              : f.status === "failed"
                                ? badgeRedStyle
                                : badgeGrayStyle),
                        }}
                      >
                        {f.status}
                      </span>
                      {f.skippedReason ? (
                        <span style={followUpDetailStyle}>
                          reason: {f.skippedReason}
                        </span>
                      ) : null}
                    </div>
                    <div style={followUpDetailStyle}>dueAt: {fmt(f.dueAt)}</div>
                    <div style={followUpDetailStyle}>
                      sentAt: {fmt(f.sentAt)}
                    </div>
                    <div style={followUpDetailStyle}>
                      message: {f.followUpMessage.slice(0, 90)}
                    </div>
                    {f.error ? (
                      <div style={followUpErrorStyle}>error: {f.error}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
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
  padding: "32px 48px 40px",
};

const backLinkStyle: CSSProperties = {
  display: "inline-block",
  color: "rgba(236, 254, 255, 0.82)",
  fontSize: 13.5,
  fontWeight: 700,
  textDecoration: "none",
};

const heroTitleStyle: CSSProperties = {
  margin: "18px 0 0 0",
  fontSize: 30,
  fontWeight: 800,
  color: "#ffffff",
};

const heroSubStyle: CSSProperties = {
  margin: "8px 0 0 0",
  fontSize: 14.5,
  color: "rgba(236, 254, 255, 0.8)",
  maxWidth: 560,
};

const contentStyle: CSSProperties = {
  maxWidth: 760,
  margin: "-16px auto 0",
  padding: "0 24px",
};

const searchRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  background: "#ffffff",
  borderRadius: 18,
  border: "1px solid #e2ede9",
  padding: 14,
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.08)",
};

const inputStyle: CSSProperties = {
  flex: 1,
  border: "1px solid #dbe6e2",
  borderRadius: 12,
  padding: "12px 14px",
  fontSize: 14.5,
  fontFamily: "'IBM Plex Mono', monospace",
  outline: "none",
};

const lookupButtonStyle: CSSProperties = {
  border: "none",
  background: "#0f766e",
  color: "#ffffff",
  borderRadius: 12,
  padding: "12px 22px",
  fontSize: 14.5,
  fontWeight: 700,
  cursor: "pointer",
};

const lookupButtonDisabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

const errorStateStyle: CSSProperties = {
  marginTop: 16,
  padding: "16px 18px",
  borderRadius: 14,
  background: "rgba(220, 38, 38, 0.06)",
  color: "#b91c1c",
  fontSize: 14,
};

const scanNoticeStyle: CSSProperties = {
  marginTop: 16,
  padding: "12px 16px",
  borderRadius: 12,
  background: "rgba(217, 119, 6, 0.08)",
  color: "#b45309",
  fontSize: 12.5,
  fontWeight: 600,
};

const emptyStateStyle: CSSProperties = {
  marginTop: 16,
  padding: "30px 10px",
  textAlign: "center",
  color: "#94a3b8",
  fontSize: 14.5,
};

const panelStyle: CSSProperties = {
  marginTop: 20,
  background: "#ffffff",
  borderRadius: 20,
  border: "1px solid #e2ede9",
  padding: "24px 26px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.08)",
};

const convoHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 12,
};

const convoOwnerStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "#0f172a",
};

const convoIdStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 12,
  color: "#94a3b8",
  fontFamily: "'IBM Plex Mono', monospace",
};

const badgeRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 700,
};

const badgeGreenStyle: CSSProperties = {
  background: "rgba(16, 185, 129, 0.12)",
  color: "#047857",
};

const badgeGrayStyle: CSSProperties = {
  background: "#f1f5f9",
  color: "#64748b",
};

const badgeRedStyle: CSSProperties = {
  background: "rgba(220, 38, 38, 0.1)",
  color: "#b91c1c",
};

const sectionLabelStyle: CSSProperties = {
  marginTop: 20,
  fontSize: 12.5,
  fontWeight: 700,
  color: "#5b6b76",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const timelineStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const messageRowStyle: CSSProperties = {
  borderRadius: 14,
  padding: "10px 14px",
  border: "1px solid #e2ede9",
};

const messageInboundStyle: CSSProperties = {
  background: "#f4fbf9",
};

const messageOutboundStyle: CSSProperties = {
  background: "#ffffff",
};

const messageMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const messageDirectionStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
  color: "#0f766e",
};

const followUpTagStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 800,
  color: "#b45309",
  background: "rgba(217, 119, 6, 0.12)",
  padding: "2px 8px",
  borderRadius: 999,
};

const messageStatusStyle: CSSProperties = {
  fontSize: 11.5,
  color: "#94a3b8",
};

const messageTimeStyle: CSSProperties = {
  fontSize: 11.5,
  color: "#94a3b8",
  marginLeft: "auto",
};

const messageBodyStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 13.5,
  color: "#0f172a",
};

const followUpListStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const followUpCardStyle: CSSProperties = {
  borderRadius: 14,
  border: "1px solid #e2ede9",
  padding: "12px 14px",
  background: "#f4fbf9",
};

const followUpStatusRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};

const followUpDetailStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 12.5,
  color: "#5b6b76",
};

const followUpErrorStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 12.5,
  color: "#b91c1c",
};
