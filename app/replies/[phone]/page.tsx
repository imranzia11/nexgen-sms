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
  updateDoc,
  type Query,
  type DocumentData,
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

type AppUser = {
  uid: string;
  role: string;
  isActive: boolean;
  email?: string;
  name?: string;
  assignedTwilioNumber?: string;
  twilioNumber?: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
};

type ConversationMeta = {
  id: string;
  phone: string;
  name?: string;
  status?: string;
  hasReply?: boolean;
  unreadCount?: number;
  lastDirection?: string;
  twilioNumber?: string;
  assignedTwilioNumber?: string;
  messagingServiceSid?: string;
  ownerUid?: string;
  lastMessage?: string;
  lastMessageAt?: any;
  updatedAt?: any;
};

function normalizePhone(value: string) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function phoneDocId(phone: string) {
  return normalizePhone(phone);
}

function toMillis(value: any) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value?.seconds && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  return 0;
}

function safeString(value: any) {
  return String(value || "").trim();
}

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
  const [profile, setProfile] = useState<AppUser | null>(null);
  const [conversationMeta, setConversationMeta] =
    useState<ConversationMeta | null>(null);

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "end",
      });
    });
  }

  function makeMessageItem(id: string, data: Record<string, any>): MessageItem {
    const timeValue = data.createdAt || data.updatedAt || null;

    return {
      id,
      sid: safeString(data.sid || data.messageSid || data.twilioSid),
      from: safeString(data.from),
      to: safeString(data.to),
      body: safeString(data.body || data.message || data.text),
      direction: safeString(data.direction || data.type).toLowerCase(),
      status: safeString(data.status),
      read: !!data.read,
      createdAtLabel: formatFirestoreDateNY(timeValue),
      createdAtMs: toMillis(timeValue),
    };
  }

  function buildFallbackConversationMessage(meta: ConversationMeta): MessageItem[] {
    const fallbackBody = safeString(meta.lastMessage);
    if (!fallbackBody) return [];

    const fallbackDirection =
      safeString(meta.lastDirection).toLowerCase() === "inbound"
        ? "inbound"
        : "outbound";

    const twilioSideNumber = safeString(
      meta.twilioNumber || meta.assignedTwilioNumber
    );

    const fallbackTime = meta.lastMessageAt || meta.updatedAt || null;

    return [
      {
        id: `fallback-${meta.id}`,
        sid: "",
        from: fallbackDirection === "inbound" ? meta.phone : twilioSideNumber,
        to: fallbackDirection === "outbound" ? meta.phone : twilioSideNumber,
        body: fallbackBody,
        direction: fallbackDirection,
        status: "saved",
        read: true,
        createdAtLabel: formatFirestoreDateNY(fallbackTime),
        createdAtMs: toMillis(fallbackTime),
      },
    ];
  }

  async function safeGetDocs(q: Query<DocumentData>) {
    try {
      const snap = await getDocs(q);
      return snap.docs;
    } catch (error) {
      console.error("Query failed", error);
      return [];
    }
  }

  async function markConversationRead(
    metaArg?: ConversationMeta,
    profileArg?: AppUser
  ) {
    try {
      const currentMeta = metaArg || conversationMeta;
      const currentProfile = profileArg || profile;

      if (!currentMeta?.id || !currentProfile) return;

      const convoRef = doc(db, "conversations", currentMeta.id);
      await updateDoc(convoRef, {
        unreadCount: 0,
      });
    } catch (error) {
      console.error("Failed to mark conversation read", error);
    }
  }

  async function loadConversationMeta(profileArg?: AppUser) {
    try {
      if (!routePhone) {
        setStatus("Phone number is missing.");
        return null;
      }

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setStatus("User profile is missing.");
        return null;
      }

      setStatus("");

      const ownedConversationId = `${currentProfile.uid}_${phoneDocId(routePhone)}`;
      const ownedConversationRef = doc(db, "conversations", ownedConversationId);
      const ownedConversationSnap = await getDoc(ownedConversationRef);

      if (!ownedConversationSnap.exists()) {
        setStatus("Conversation not found.");
        setConversationMeta(null);
        setThreadTitle(routePhone || "Conversation");
        return null;
      }

      const data = ownedConversationSnap.data() as Record<string, any>;

      if (safeString(data.ownerUid) !== currentProfile.uid) {
        setStatus("Access denied.");
        setConversationMeta(null);
        return null;
      }

      const meta: ConversationMeta = {
        id: ownedConversationSnap.id,
        phone: safeString(data.phone || routePhone),
        name: safeString(data.name),
        status: safeString(data.status),
        hasReply: data.hasReply === true,
        unreadCount: Number(data.unreadCount || 0),
        lastDirection: safeString(data.lastDirection),
        twilioNumber: safeString(data.twilioNumber),
        assignedTwilioNumber: safeString(data.assignedTwilioNumber),
        messagingServiceSid: safeString(data.messagingServiceSid),
        ownerUid: safeString(data.ownerUid),
        lastMessage: safeString(data.lastMessage),
        lastMessageAt: data.lastMessageAt || null,
        updatedAt: data.updatedAt || null,
      };

      setConversationMeta(meta);
      setThreadTitle(
        meta.name ? `${meta.name} · ${meta.phone}` : meta.phone || "Conversation"
      );
      return meta;
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to load conversation.");
      return null;
    }
  }

  async function loadThreadOnce(metaArg?: ConversationMeta, profileArg?: AppUser) {
    try {
      setLoading(true);
      setStatus("");

      const currentMeta = metaArg || conversationMeta;
      const currentProfile = profileArg || profile;

      if (!currentProfile || !currentMeta?.id) {
        setMessages([]);
        return;
      }

      const store = new Map<string, MessageItem>();
      const targetPhone = normalizePhone(currentMeta.phone || "");

      const addToStore = (
        prefix: string,
        id: string,
        data: Record<string, any>
      ) => {
        const ownerUid = safeString(data.ownerUid || data.userId);
        const conversationId = safeString(data.conversationId);
        const from = normalizePhone(safeString(data.from));
        const to = normalizePhone(safeString(data.to));
        const phone = normalizePhone(safeString(data.phone));

        const matchesLegacyPhone =
          from === targetPhone || to === targetPhone || phone === targetPhone;

        const matchesConversation =
          conversationId === currentMeta.id ||
          (ownerUid === currentProfile.uid && matchesLegacyPhone);

        if (!matchesConversation) return;

        const item = makeMessageItem(`${prefix}-${id}`, data);
        const dedupeKey =
          item.sid ||
          `${item.direction}_${normalizePhone(item.from || "")}_${normalizePhone(
            item.to || ""
          )}_${item.body}_${item.createdAtMs}`;

        store.set(dedupeKey, item);
      };

      const subMessagesDocs = await safeGetDocs(
        query(
          collection(db, "conversations", currentMeta.id, "messages"),
          orderBy("createdAt", "asc")
        )
      );

      subMessagesDocs.forEach((d) => {
        addToStore("conv", d.id, d.data() as Record<string, any>);
      });

      const rootMessageQueries: Query<DocumentData>[] = [
        query(collection(db, "messages"), where("conversationId", "==", currentMeta.id)),
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("phone", "==", currentMeta.phone)
        ),
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("to", "==", currentMeta.phone)
        ),
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("from", "==", currentMeta.phone)
        ),
      ];

      for (const q of rootMessageQueries) {
        const docs = await safeGetDocs(q);
        docs.forEach((d) => {
          addToStore("msg", d.id, d.data() as Record<string, any>);
        });
      }

      const rootReplyQueries: Query<DocumentData>[] = [
        query(collection(db, "replies"), where("conversationId", "==", currentMeta.id)),
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("phone", "==", currentMeta.phone)
        ),
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("to", "==", currentMeta.phone)
        ),
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("from", "==", currentMeta.phone)
        ),
      ];

      for (const q of rootReplyQueries) {
        const docs = await safeGetDocs(q);
        docs.forEach((d) => {
          addToStore("reply", d.id, d.data() as Record<string, any>);
        });
      }

      let merged = Array.from(store.values()).sort(
        (a, b) => a.createdAtMs - b.createdAtMs
      );

      if (merged.length === 0) {
        merged = buildFallbackConversationMessage(currentMeta);
      }

      setMessages(merged);
      await markConversationRead(currentMeta, currentProfile);
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

  async function handleManualRefresh() {
    const meta = await loadConversationMeta();
    if (!meta) return;
    await loadThreadOnce(meta);
  }

  useEffect(() => {
    if (!routePhone) return;

    let unsubConversationMessages: (() => void) | undefined;
    let unsubRootMessages: (() => void) | undefined;
    let unsubReplies: (() => void) | undefined;
    let unsubAuth: (() => void) | undefined;

    unsubAuth = onAuthStateChanged(auth, async (user) => {
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

        const userData = userSnap.data() as Record<string, any>;
        const safeProfile: AppUser = {
          uid: user.uid,
          role: String(userData.role || "user"),
          isActive: userData.isActive === true,
          email: String(userData.email || user.email || ""),
          name: String(userData.name || ""),
          assignedTwilioNumber: String(userData.assignedTwilioNumber || ""),
          twilioNumber: String(userData.twilioNumber || ""),
          phoneNumber: String(userData.phoneNumber || ""),
          messagingServiceSid: String(userData.messagingServiceSid || ""),
        };

        setProfile(safeProfile);
        setChecking(false);

        const meta = await loadConversationMeta(safeProfile);
        if (!meta) {
          setLoading(false);
          setMessages([]);
          return;
        }

        await loadThreadOnce(meta, safeProfile);

        const refreshFromAnyChange = async () => {
          const latestMeta = await loadConversationMeta(safeProfile);
          if (!latestMeta) return;
          await loadThreadOnce(latestMeta, safeProfile);
        };

        unsubConversationMessages = onSnapshot(
          query(
            collection(db, "conversations", meta.id, "messages"),
            orderBy("createdAt", "asc")
          ),
          async () => {
            await refreshFromAnyChange();
          },
          (error: any) => {
            console.error(error);
          }
        );

        unsubRootMessages = onSnapshot(
          query(collection(db, "messages"), where("ownerUid", "==", safeProfile.uid)),
          async () => {
            await refreshFromAnyChange();
          },
          (error: any) => {
            console.error(error);
          }
        );

        unsubReplies = onSnapshot(
          query(collection(db, "replies"), where("ownerUid", "==", safeProfile.uid)),
          async () => {
            await refreshFromAnyChange();
          },
          (error: any) => {
            console.error(error);
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
      if (unsubAuth) unsubAuth();
      if (unsubConversationMessages) unsubConversationMessages();
      if (unsubRootMessages) unsubRootMessages();
      if (unsubReplies) unsubReplies();
    };
  }, [routePhone, router]);

  async function handleSendReply() {
    if (!conversationMeta?.phone) {
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
          to: conversationMeta.phone,
          phone: conversationMeta.phone,
          body: replyBody.trim(),
          name: conversationMeta.name || "",
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus(data.error || "Failed to send reply.");
        return;
      }

      setReplyBody("");
      setStatus("Reply sent.");
      await handleManualRefresh();

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
                  View the full SMS thread, monitor inbound and outbound messages,
                  and send replies from the same premium panel.
                </p>
              </div>

              <div style={heroActionsStyle}>
                <div style={heroInfoChipStyle}>
                  <span style={heroInfoLabelStyle}>Phone</span>
                  <span style={heroInfoValueStyle}>
                    {conversationMeta?.phone || routePhone || "-"}
                  </span>
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
                  <p style={panelDescStyle}>Full customer conversation history.</p>
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
                                ...(inbound
                                  ? inboundDirectionStyle
                                  : outboundDirectionStyle),
                              }}
                            >
                              {msg.direction || "message"}
                            </span>

                            {msg.status ? (
                              <span
                                style={{
                                  ...bubbleStatusStyle,
                                  color: inbound
                                    ? "#64748b"
                                    : "rgba(236,254,255,0.84)",
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
                              color: inbound
                                ? "#64748b"
                                : "rgba(236,254,255,0.8)",
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
                <MiniInfoCard
                  label="Recipient"
                  value={conversationMeta?.phone || routePhone || "-"}
                />
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