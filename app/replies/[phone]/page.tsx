"use client";

import Link from "next/link";
import {
  use,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";
import { formatFirestoreDateNY } from "../../../lib/date";

type MessageItem = {
  id: string;
  sid?: string;
  from?: string;
  to?: string;
  body?: string;
  direction?: string;
  status?: string;
  read?: boolean;
  createdAtLabel: string;
  createdAtMs: number;
};

export default function ReplyThreadPage({
  params,
}: {
  params: Promise<{ phone: string }>;
}) {
  const router = useRouter();
  const resolved = use(params);
  const routePhone = decodeURIComponent(resolved.phone || "").trim();

  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [threadTitle, setThreadTitle] = useState(routePhone || "Conversation");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [status, setStatus] = useState("");

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "end",
      });
    });
  }

  function toMillis(value: any) {
    if (value && typeof value.toMillis === "function") {
      return value.toMillis();
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "number") {
      return value;
    }
    return 0;
  }

  async function loadConversationMeta() {
    try {
      if (!routePhone) {
        setStatus("Phone number is missing.");
        return false;
      }

      setThreadTitle(routePhone || "Conversation");
      setStatus("");
      return true;
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to load conversation.");
      return false;
    }
  }

  async function handleManualRefresh() {
    setStatus("");
    const ok = await loadConversationMeta();
    if (!ok) return;

    try {
      setLoading(true);

      const outboundQuery = query(
        collection(db, "messages"),
        where("to", "==", routePhone),
        orderBy("createdAt", "asc")
      );

      const inboundQueryPrimary = query(
        collection(db, "replies"),
        where("from", "==", routePhone),
        orderBy("createdAt", "asc")
      );

      const inboundQueryFallback = query(
        collection(db, "replies"),
        where("phone", "==", routePhone),
        orderBy("createdAt", "asc")
      );

      const [outboundSnap, inboundSnapPrimary, inboundSnapFallback] =
        await Promise.all([
          getDocs(outboundQuery),
          getDocs(inboundQueryPrimary),
          getDocs(inboundQueryFallback),
        ]);

      const outboundItems: MessageItem[] = outboundSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: `msg-${d.id}`,
          sid: data.sid || "",
          from: data.from || "",
          to: data.to || "",
          body: data.body || "",
          direction: data.direction || "outbound",
          status: data.status || "",
          read: !!data.read,
          createdAtLabel: formatFirestoreDateNY(data.createdAt),
          createdAtMs: toMillis(data.createdAt),
        };
      });

      const inboundMap = new Map<string, MessageItem>();

      [...inboundSnapPrimary.docs, ...inboundSnapFallback.docs].forEach((d) => {
        const data = d.data();
        const id = `reply-${d.id}`;
        inboundMap.set(id, {
          id,
          sid: data.sid || "",
          from: data.from || data.phone || "",
          to: data.to || "",
          body: data.body || "",
          direction: data.direction || "inbound",
          status: data.status || "",
          read: !!data.read,
          createdAtLabel: formatFirestoreDateNY(data.createdAt),
          createdAtMs: toMillis(data.createdAt),
        });
      });

      const merged = [...outboundItems, ...Array.from(inboundMap.values())].sort(
        (a, b) => a.createdAtMs - b.createdAtMs
      );

      setMessages(merged);
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to refresh conversation.");
      setMessages([]);
    } finally {
      setLoading(false);
      setTimeout(() => {
        scrollToBottom(false);
      }, 60);
    }
  }

  useEffect(() => {
    if (!routePhone) return;

    let unsubOutbound: (() => void) | undefined;
    let unsubInboundPrimary: (() => void) | undefined;
    let unsubInboundFallback: (() => void) | undefined;

    const outboundStore = new Map<string, MessageItem>();
    const inboundStore = new Map<string, MessageItem>();

    function syncMergedMessages() {
      const merged = [
        ...Array.from(outboundStore.values()),
        ...Array.from(inboundStore.values()),
      ].sort((a, b) => a.createdAtMs - b.createdAtMs);

      setMessages(merged);
      setLoading(false);

      setTimeout(() => {
        scrollToBottom(false);
      }, 60);
    }

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        await signOut(auth).catch(() => {});
        router.push("/login");
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));

        if (!userSnap.exists() || userSnap.data().isActive !== true) {
          await signOut(auth).catch(() => {});
          router.push("/login");
          return;
        }

        setChecking(false);

        const ok = await loadConversationMeta();
        if (!ok) {
          setLoading(false);
          setMessages([]);
          return;
        }

        const outboundQuery = query(
          collection(db, "messages"),
          where("to", "==", routePhone),
          orderBy("createdAt", "asc")
        );

        const inboundQueryPrimary = query(
          collection(db, "replies"),
          where("from", "==", routePhone),
          orderBy("createdAt", "asc")
        );

        const inboundQueryFallback = query(
          collection(db, "replies"),
          where("phone", "==", routePhone),
          orderBy("createdAt", "asc")
        );

        unsubOutbound = onSnapshot(
          outboundQuery,
          (snap) => {
            outboundStore.clear();

            snap.docs.forEach((d) => {
              const data = d.data();
              outboundStore.set(`msg-${d.id}`, {
                id: `msg-${d.id}`,
                sid: data.sid || "",
                from: data.from || "",
                to: data.to || "",
                body: data.body || "",
                direction: data.direction || "outbound",
                status: data.status || "",
                read: !!data.read,
                createdAtLabel: formatFirestoreDateNY(data.createdAt),
                createdAtMs: toMillis(data.createdAt),
              });
            });

            syncMergedMessages();
          },
          (error: any) => {
            console.error(error);
            setStatus(error?.message || "Failed to load outbound messages.");
            setLoading(false);
          }
        );

        unsubInboundPrimary = onSnapshot(
          inboundQueryPrimary,
          (snap) => {
            // remove previous items that came from this source
            Array.from(inboundStore.keys()).forEach((key) => {
              if (key.startsWith("reply-primary-")) inboundStore.delete(key);
            });

            snap.docs.forEach((d) => {
              const data = d.data();
              inboundStore.set(`reply-primary-${d.id}`, {
                id: `reply-primary-${d.id}`,
                sid: data.sid || "",
                from: data.from || data.phone || "",
                to: data.to || "",
                body: data.body || "",
                direction: data.direction || "inbound",
                status: data.status || "",
                read: !!data.read,
                createdAtLabel: formatFirestoreDateNY(data.createdAt),
                createdAtMs: toMillis(data.createdAt),
              });
            });

            syncMergedMessages();
          },
          (error: any) => {
            console.error(error);
            setStatus(error?.message || "Failed to load inbound replies.");
            setLoading(false);
          }
        );

        unsubInboundFallback = onSnapshot(
          inboundQueryFallback,
          (snap) => {
            Array.from(inboundStore.keys()).forEach((key) => {
              if (key.startsWith("reply-fallback-")) inboundStore.delete(key);
            });

            snap.docs.forEach((d) => {
              const data = d.data();
              inboundStore.set(`reply-fallback-${d.id}`, {
                id: `reply-fallback-${d.id}`,
                sid: data.sid || "",
                from: data.from || data.phone || "",
                to: data.to || "",
                body: data.body || "",
                direction: data.direction || "inbound",
                status: data.status || "",
                read: !!data.read,
                createdAtLabel: formatFirestoreDateNY(data.createdAt),
                createdAtMs: toMillis(data.createdAt),
              });
            });

            syncMergedMessages();
          },
          (error: any) => {
            console.error(error);
            setStatus(error?.message || "Failed to load inbound replies.");
            setLoading(false);
          }
        );
      } catch (error: any) {
        console.error(error);
        setStatus(error?.message || "Failed to load conversation.");
        setMessages([]);
        setLoading(false);
      }
    });

    return () => {
      unsubAuth();
      if (unsubOutbound) unsubOutbound();
      if (unsubInboundPrimary) unsubInboundPrimary();
      if (unsubInboundFallback) unsubInboundFallback();
    };
  }, [routePhone, router]);

  async function handleSendReply() {
    if (!routePhone) {
      setStatus("Phone number is missing.");
      return;
    }

    if (!replyBody.trim()) {
      setStatus("Please write a reply.");
      return;
    }

    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : "";

      if (!idToken) {
        setStatus("You are not signed in.");
        return;
      }

      setSending(true);
      setStatus("Sending reply...");

      const res = await fetch("/api/send-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          to: routePhone,
          phone: routePhone,
          body: replyBody.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus(data.error || "Failed to send reply.");
        return;
      }

      setReplyBody("");
      setStatus("Reply sent.");

      setTimeout(() => {
        scrollToBottom(true);
      }, 150);
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to send reply.");
    } finally {
      setSending(false);
    }
  }

  if (checking) {
    return (
      <>
        <style jsx global>{`
          @keyframes spin {
            0% {
              transform: rotate(0deg);
            }
            100% {
              transform: rotate(360deg);
            }
          }
        `}</style>

        <main style={pageStyle}>
          <div style={pageWrapStyle}>
            <section style={threadPanelStyle}>
              <div style={emptyStateStyle}>
                <div style={loadingSpinnerStyle} />
                <div style={emptyTitleStyle}>Checking account access...</div>
              </div>
            </section>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <style jsx global>{`
        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        textarea::placeholder {
          color: rgba(100, 116, 139, 0.9);
        }
      `}</style>

      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <div style={heroStyle}>
            <div style={heroOverlayStyle} />

            <div style={heroInnerStyle}>
              <div>
                <div style={heroBadgeStyle}>Conversation Workspace</div>
                <h1 style={heroTitleStyle}>{threadTitle}</h1>
                <p style={heroTextStyle}>
                  View the full SMS thread, monitor inbound and outbound messages, and send replies from the same premium panel.
                </p>
              </div>

              <div style={heroActionsStyle}>
                <div style={heroInfoChipStyle}>
                  <span style={heroInfoLabelStyle}>Phone</span>
                  <span style={heroInfoValueStyle}>{routePhone || "-"}</span>
                </div>

                <Link href="/replies" style={backButtonStyle}>
                  Back to Replies
                </Link>
              </div>
            </div>
          </div>

          <div style={mainGridStyle}>
            <section style={threadPanelStyle}>
              <div style={panelHeaderStyle}>
                <div>
                  <h2 style={panelTitleStyle}>Message Thread</h2>
                  <p style={panelDescStyle}>
                    Full customer conversation history.
                  </p>
                </div>

                <button onClick={() => void handleManualRefresh()} style={refreshButtonStyle}>
                  Refresh
                </button>
              </div>

              {loading ? (
                <div style={emptyStateStyle}>
                  <div style={loadingSpinnerStyle} />
                  <div style={emptyTitleStyle}>Loading messages...</div>
                </div>
              ) : messages.length === 0 ? (
                <div style={emptyStateStyle}>
                  <div style={emptyDotStyle} />
                  <div style={emptyTitleStyle}>No messages yet.</div>
                  <div style={emptyTextStyle}>
                    This conversation does not have any saved messages yet.
                  </div>
                </div>
              ) : (
                <div style={threadWrapStyle}>
                  {messages.map((msg) => {
                    const inbound = msg.direction === "inbound";

                    return (
                      <div
                        key={msg.id}
                        style={{
                          display: "flex",
                          justifyContent: inbound ? "flex-start" : "flex-end",
                        }}
                      >
                        <div
                          style={{
                            ...messageBubbleStyle,
                            ...(inbound ? inboundBubbleStyle : outboundBubbleStyle),
                            color: inbound ? "#0f172a" : "#ffffff",
                          }}
                        >
                          <div style={bubbleTopStyle}>
                            <span
                              style={{
                                ...bubbleDirectionStyle,
                                ...(inbound ? inboundDirectionStyle : outboundDirectionStyle),
                              }}
                            >
                              {msg.direction || "message"}
                            </span>

                            {msg.status ? (
                              <span
                                style={{
                                  ...bubbleStatusStyle,
                                  color: inbound ? "#64748b" : "rgba(236,254,255,0.84)",
                                }}
                              >
                                {msg.status}
                              </span>
                            ) : null}
                          </div>

                          <div style={bubbleBodyStyle}>{msg.body || "-"}</div>

                          <div
                            style={{
                              ...bubbleTimeStyle,
                              color: inbound ? "#64748b" : "rgba(236,254,255,0.8)",
                            }}
                          >
                            {msg.createdAtLabel}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  <div ref={threadEndRef} />
                </div>
              )}
            </section>

            <section style={composerPanelStyle}>
              <div style={panelHeaderStyle}>
                <div>
                  <h2 style={panelTitleStyle}>Send Reply</h2>
                  <p style={panelDescStyle}>
                    Write a response and send it directly to this conversation.
                  </p>
                </div>
              </div>

              <div style={miniInfoGridStyle}>
                <MiniInfoCard label="Recipient" value={routePhone || "-"} />
                <MiniInfoCard label="Messages" value={String(messages.length)} />
              </div>

              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                rows={10}
                placeholder="Write your SMS reply..."
                style={textareaStyle}
              />

              <div style={replyMetaStyle}>
                <span>Characters:</span>
                <strong>{replyBody.length}</strong>
              </div>

              <div style={buttonRowStyle}>
                <button
                  onClick={handleSendReply}
                  disabled={sending || !replyBody.trim()}
                  style={{
                    ...sendButtonStyle,
                    opacity: sending || !replyBody.trim() ? 0.6 : 1,
                    cursor: sending || !replyBody.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {sending ? "Sending..." : "Send SMS Reply"}
                </button>

                <button
                  onClick={() => void handleManualRefresh()}
                  style={secondaryButtonStyle}
                >
                  Refresh Thread
                </button>
              </div>

              {status ? <div style={statusBoxStyle}>{status}</div> : null}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

function MiniInfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniInfoCardStyle}>
      <div style={miniInfoLabelStyle}>{label}</div>
      <div style={miniInfoValueStyle}>{value}</div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(20,184,166,0.18), transparent 28%), linear-gradient(180deg, #ecfeff 0%, #f8fafc 46%, #f8fafc 100%)",
  color: "#0f172a",
  padding: 24,
};

const pageWrapStyle: CSSProperties = {
  maxWidth: 1260,
  margin: "0 auto",
  display: "grid",
  gap: 20,
};

const heroStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  borderRadius: 32,
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 30px 80px rgba(13, 148, 136, 0.28)",
};

const heroOverlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(circle at top right, rgba(255,255,255,0.18), transparent 24%), radial-gradient(circle at bottom left, rgba(255,255,255,0.08), transparent 28%)",
  pointerEvents: "none",
};

const heroInnerStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  padding: 28,
  display: "grid",
  gap: 22,
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
  letterSpacing: 0.3,
};

const heroTitleStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "#ffffff",
  fontSize: 40,
  lineHeight: 1.05,
  fontWeight: 900,
  wordBreak: "break-word",
};

const heroTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  maxWidth: 760,
  color: "rgba(236,254,255,0.86)",
  fontSize: 16,
  lineHeight: 1.65,
};

const heroActionsStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
};

const heroInfoChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 16px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.16)",
  color: "#ffffff",
  backdropFilter: "blur(10px)",
};

const heroInfoLabelStyle: CSSProperties = {
  color: "rgba(236,254,255,0.7)",
  fontSize: 13,
  fontWeight: 700,
};

const heroInfoValueStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 900,
  wordBreak: "break-word",
};

const backButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.15fr 0.85fr",
  gap: 20,
  alignItems: "start",
};

const threadPanelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  minHeight: 720,
};

const composerPanelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  position: "sticky",
  top: 24,
};

const panelHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 14,
  flexWrap: "wrap",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 900,
  color: "#0f172a",
};

const panelDescStyle: CSSProperties = {
  margin: "8px 0 0 0",
  color: "#64748b",
  fontSize: 14,
  lineHeight: 1.5,
};

const refreshButtonStyle: CSSProperties = {
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  cursor: "pointer",
};

const threadWrapStyle: CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
  maxHeight: 650,
  overflowY: "auto",
  paddingRight: 4,
};

const messageBubbleStyle: CSSProperties = {
  maxWidth: "80%",
  borderRadius: 24,
  padding: 16,
  boxShadow: "0 10px 24px rgba(15,23,42,0.06)",
};

const inboundBubbleStyle: CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  border: "1px solid #dbeafe",
};

const outboundBubbleStyle: CSSProperties = {
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  border: "1px solid rgba(13,148,136,0.18)",
};

const bubbleTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

const bubbleDirectionStyle: CSSProperties = {
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 11,
  fontWeight: 900,
  textTransform: "capitalize",
  letterSpacing: 0.2,
};

const inboundDirectionStyle: CSSProperties = {
  background: "rgba(59,130,246,0.10)",
  color: "#2563eb",
  border: "1px solid rgba(59,130,246,0.18)",
};

const outboundDirectionStyle: CSSProperties = {
  background: "rgba(255,255,255,0.14)",
  color: "#ecfeff",
  border: "1px solid rgba(255,255,255,0.18)",
};

const bubbleStatusStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: "capitalize",
};

const bubbleBodyStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 15,
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
};

const bubbleTimeStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  opacity: 0.82,
};

const miniInfoGridStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};

const miniInfoCardStyle: CSSProperties = {
  borderRadius: 18,
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  padding: 16,
  border: "1px solid #eef2f7",
};

const miniInfoLabelStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  fontWeight: 800,
};

const miniInfoValueStyle: CSSProperties = {
  marginTop: 10,
  color: "#0f172a",
  fontSize: 16,
  fontWeight: 900,
  wordBreak: "break-word",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  marginTop: 18,
  borderRadius: 18,
  border: "1px solid #dbe3ed",
  padding: "14px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 15,
  resize: "vertical",
  outline: "none",
  minHeight: 220,
};

const replyMetaStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  color: "#64748b",
  fontSize: 13,
};

const buttonRowStyle: CSSProperties = {
  marginTop: 18,
  display: "grid",
  gap: 12,
};

const sendButtonStyle: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: 18,
  padding: "16px 18px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 16,
  boxShadow: "0 18px 35px rgba(13,148,136,0.24)",
};

const secondaryButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 16,
  padding: "14px 18px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  fontSize: 15,
  cursor: "pointer",
};

const statusBoxStyle: CSSProperties = {
  marginTop: 14,
  borderRadius: 18,
  padding: "14px 16px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  fontSize: 14,
  lineHeight: 1.5,
};

const emptyStateStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 22,
  padding: "38px 20px",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  display: "grid",
  justifyItems: "center",
  gap: 10,
  textAlign: "center",
};

const emptyDotStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  background: "#e2e8f0",
};

const emptyTitleStyle: CSSProperties = {
  fontSize: 16,
  color: "#334155",
  fontWeight: 800,
};

const emptyTextStyle: CSSProperties = {
  fontSize: 14,
  color: "#64748b",
  lineHeight: 1.6,
  maxWidth: 460,
};

const loadingSpinnerStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "3px solid rgba(15,118,110,0.18)",
  borderTop: "3px solid #0f766e",
  animation: "spin 1s linear infinite",
};