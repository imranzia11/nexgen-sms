"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { formatFirestoreDateNY } from "../../lib/date";

type ToastType = "success" | "error" | "info";

type BlacklistedItem = {
  id: string;
  phone: string;
  status: string;
  reason?: string;
  source?: string;
  lastKeyword?: string;
  lastBody?: string;
  blockedAtLabel: string;
  updatedAtLabel: string;
};

type ReplyItem = {
  id: string;
  phone: string;
  body: string;
  eventType?: string;
  optOutType?: string;
  createdAtLabel: string;
};

function statusChipTone(status?: string) {
  const value = String(status || "").toLowerCase();

  if (value.includes("blocked")) {
    return {
      bg: "rgba(239, 68, 68, 0.12)",
      text: "#dc2626",
      border: "rgba(239, 68, 68, 0.25)",
    };
  }

  if (value.includes("active")) {
    return {
      bg: "rgba(16, 185, 129, 0.12)",
      text: "#059669",
      border: "rgba(16, 185, 129, 0.25)",
    };
  }

  return {
    bg: "rgba(59, 130, 246, 0.12)",
    text: "#2563eb",
    border: "rgba(59, 130, 246, 0.25)",
  };
}

function truncateMiddle(value: string, start = 16, end = 10) {
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export default function BlacklistedPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [uid, setUid] = useState("");
  const [adminName, setAdminName] = useState("User");
  const [loadingList, setLoadingList] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [items, setItems] = useState<BlacklistedItem[]>([]);
  const [replies, setReplies] = useState<ReplyItem[]>([]);

  const [toastOpen, setToastOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState<ToastType>("info");

  const showToast = (msg: string, type: ToastType = "info") => {
    setToastMessage(msg);
    setToastType(type);
    setToastOpen(true);

    window.setTimeout(() => {
      setToastOpen(false);
    }, 4000);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));

        if (!snap.exists() || snap.data().isActive !== true) {
          await signOut(auth);
          router.push("/login");
          return;
        }

        setAdminName(snap.data().name || "User");
        setUid(user.uid);
        setChecking(false);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth);
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (checking || !uid) return;

    const q = query(
      collection(db, "blacklisted_numbers"),
      where("ownerUid", "==", uid),
      orderBy("updatedAt", "desc")
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: BlacklistedItem[] = snap.docs
          .map((d) => {
            const data = d.data();

            return {
              id: d.id,
              phone: data.phone || d.id || "-",
              status: data.status || "",
              reason: data.reason || "",
              source: data.source || "",
              lastKeyword: data.lastKeyword || "",
              lastBody: data.lastBody || "",
              blockedAtLabel: formatFirestoreDateNY(data.blockedAt),
              updatedAtLabel: formatFirestoreDateNY(data.updatedAt),
            };
          })
          .filter(
            (item) => String(item.status || "").toLowerCase() === "blocked"
          );

        setItems(next);
        setLoadingList(false);
      },
      (error) => {
        console.error("Failed to load blacklisted numbers", error);
        setLoadingList(false);
        showToast("Failed to load black listed numbers.", "error");
      }
    );

    return () => unsub();
  }, [checking, uid]);

  useEffect(() => {
    if (checking || !uid) return;

    const q = query(
      collection(db, "replies"),
      where("ownerUid", "==", uid),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: ReplyItem[] = snap.docs.map((d) => {
          const data = d.data();

          return {
            id: d.id,
            phone: data.phone || data.from || "",
            body: data.body || "",
            eventType: data.eventType || "",
            optOutType: data.optOutType || "",
            createdAtLabel: formatFirestoreDateNY(data.createdAt),
          };
        });

        setReplies(next);
      },
      (error) => {
        console.error("Failed to load replies", error);
      }
    );

    return () => unsub();
  }, [checking, uid]);

  const handleLogout = async () => {
    await signOut(auth);
    router.push("/login");
  };

  const handleContactSupport = () => {
    window.open("https://wa.me/971523480839", "_blank", "noopener,noreferrer");
  };

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return items;

    return items.filter((item) => {
      return (
        String(item.phone || "").toLowerCase().includes(term) ||
        String(item.lastKeyword || "").toLowerCase().includes(term) ||
        String(item.reason || "").toLowerCase().includes(term) ||
        String(item.source || "").toLowerCase().includes(term) ||
        String(item.lastBody || "").toLowerCase().includes(term)
      );
    });
  }, [items, searchTerm]);

  const repliesByPhone = useMemo(() => {
    const map = new Map<string, ReplyItem[]>();

    for (const reply of replies) {
      const phone = String(reply.phone || "").trim();
      if (!phone) continue;

      if (!map.has(phone)) {
        map.set(phone, []);
      }

      map.get(phone)!.push(reply);
    }

    return map;
  }, [replies]);

  const totalBlocked = items.length;
  const latestBlocked = items[0]?.phone || "-";

  if (checking) {
    return (
      <main style={loadingPageStyle}>
        <GlobalStyles />
        <div style={loadingCardStyle}>
          <div style={spinnerStyle} />
          <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#e6fffb" }}>
            Checking account access...
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <GlobalStyles />

      {toastOpen ? (
        <div
          style={{
            ...toastStyle,
            ...(toastType === "success"
              ? toastSuccessStyle
              : toastType === "error"
              ? toastErrorStyle
              : toastInfoStyle),
          }}
        >
          <div
            style={{
              ...toastDotStyle,
              background:
                toastType === "success"
                  ? "#34d399"
                  : toastType === "error"
                  ? "#f87171"
                  : "#22d3ee",
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={toastTitleStyle}>
              {toastType === "success"
                ? "Success"
                : toastType === "error"
                ? "Something went wrong"
                : "System update"}
            </div>
            <div style={toastMessageStyle}>{toastMessage}</div>
          </div>
          <button onClick={() => setToastOpen(false)} style={toastCloseStyle}>
            ×
          </button>
        </div>
      ) : null}

      <main style={pageStyle}>
        <div style={pageShellStyle}>
          <aside style={sidebarStyle}>
            <div>
              <div style={brandWrapStyle}>
                <div style={brandIconStyle}>N</div>
                <div>
                  <div style={brandTitleStyle}>Nexgen SMS</div>
                  <div style={brandSubStyle}>User Portal</div>
                </div>
              </div>

              <div style={adminMiniCardStyle}>
                <div style={avatarStyle}>
                  {adminName?.slice(0, 1)?.toUpperCase() || "U"}
                </div>
                <div>
                  <div style={sidebarSmallLabelStyle}>Signed in as</div>
                  <div style={sidebarAdminNameStyle}>{adminName}</div>
                </div>
              </div>

              <div style={sidebarRepliesWrapStyle}>
                <Link href="/dashboard" style={sidebarRepliesCardStyle}>
                  <div style={sidebarRepliesIconStyle}>⌂</div>
                  <div>
                    <div style={sidebarRepliesTitleStyle}>Dashboard</div>
                    <div style={sidebarRepliesTextStyle}>Go back to SMS control center</div>
                  </div>
                </Link>
              </div>

              <div style={sidebarRepliesWrapStyle}>
                <Link href="/replies" style={sidebarRepliesCardStyle}>
                  <div style={sidebarRepliesIconStyle}>↩</div>
                  <div>
                    <div style={sidebarRepliesTitleStyle}>Replies</div>
                    <div style={sidebarRepliesTextStyle}>Open incoming messages</div>
                  </div>
                </Link>
              </div>

              <div style={sidebarRepliesWrapStyle}>
                <div style={sidebarSupportCardStyle}>
                  <div style={sidebarSupportIconStyle}>⛔</div>
                  <div style={{ textAlign: "left" }}>
                    <div style={sidebarRepliesTitleStyle}>Black Listed Numbers</div>
                    <div style={sidebarRepliesTextStyle}>Live STOP opt-out list</div>
                  </div>
                </div>
              </div>

              <div style={sidebarRepliesWrapStyle}>
                <button
                  onClick={handleContactSupport}
                  style={sidebarSupportCardStyle}
                  type="button"
                >
                  <div style={sidebarSupportIconStyle}>?</div>
                  <div style={{ textAlign: "left" }}>
                    <div style={sidebarRepliesTitleStyle}>Contact Support</div>
                    <div style={sidebarRepliesTextStyle}>Get help for portal setup</div>
                  </div>
                </button>
              </div>
            </div>

            <div style={sidebarBottomLogoutWrapStyle}>
              <div style={{ display: "grid", gap: 12 }}>
                <Link href="/logs" style={sidebarSecondaryLinkButtonStyle}>
                  Logs
                </Link>

                <Link href="/stats" style={sidebarSecondaryLinkButtonStyle}>
                  Stats
                </Link>

                <button onClick={handleLogout} style={sidebarLogoutButtonStyle}>
                  Logout
                </button>
              </div>
            </div>
          </aside>

          <section style={contentStyle}>
            <div style={heroCardStyle}>
              <div style={heroOverlayStyle} />
              <div style={heroInnerStyle}>
                <div>
                  <div style={heroBadgeStyle}>Compliance Protection</div>
                  <h1 style={heroTitleStyle}>Black Listed Numbers</h1>
                  <p style={heroTextStyle}>
                    View all numbers that replied STOP and the replies linked to those blocked
                    numbers.
                  </p>
                </div>

                <div style={heroTopControlsStyle}>
                  <div style={searchBarStyle}>
                    <span style={{ fontSize: 16, opacity: 0.8 }}>⌕</span>
                    <input
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Search phone, keyword, reason, source, or message"
                      style={searchInputStyle}
                    />
                  </div>

                  <Link href="/dashboard" style={heroPrimaryButtonLinkStyle}>
                    Back to Dashboard
                  </Link>
                </div>

                <div style={statsGridStyle}>
                  <StatCard
                    label="Blocked Numbers"
                    value={String(totalBlocked)}
                    accent="rgba(255,255,255,0.18)"
                  />
                  <StatCard
                    label="Filtered Results"
                    value={String(filteredItems.length)}
                    accent="rgba(255,255,255,0.18)"
                  />
                  <StatCard
                    label="Latest Blocked"
                    value={latestBlocked}
                    accent="rgba(255,255,255,0.18)"
                    compact
                  />
                  <StatCard
                    label="Status"
                    value="Live Sync"
                    accent="rgba(255,255,255,0.18)"
                    compact
                  />
                </div>
              </div>
            </div>

            <section style={panelStyle}>
              <div style={panelHeaderStyle}>
                <div>
                  <h2 style={panelTitleStyle}>Blocked Number Registry</h2>
                  <p style={panelDescStyle}>
                    Each blocked number also shows the related replies saved in Firestore.
                  </p>
                </div>

                <button
                  onClick={() => showToast("List refreshes automatically.", "info")}
                  style={secondaryButtonStyle}
                  type="button"
                >
                  Refresh
                </button>
              </div>

              {loadingList ? (
                <EmptyState text="Loading black listed numbers..." />
              ) : filteredItems.length === 0 ? (
                <EmptyState text="No black listed numbers found." />
              ) : (
                <div style={blacklistCardsWrapStyle}>
                  {filteredItems.map((item) => {
                    const tone = statusChipTone(item.status);
                    const phoneReplies = (repliesByPhone.get(item.phone) || []).filter((reply) => {
                      const event = String(reply.eventType || "").toUpperCase();
                      const opt = String(reply.optOutType || "").toUpperCase();
                      return (
                        event === "STOP" ||
                        opt === "STOP" ||
                        String(reply.body || "").trim().toUpperCase() === "STOP"
                      );
                    });

                    return (
                      <div key={item.id} style={blacklistCardStyle}>
                        <div style={blacklistCardTopStyle}>
                          <div>
                            <div style={blacklistPhoneStyle}>{item.phone || "-"}</div>
                            <div style={blacklistMetaStyle}>
                              Blocked at {item.blockedAtLabel || "-"}
                            </div>
                          </div>

                          <span
                            style={{
                              background: tone.bg,
                              color: tone.text,
                              border: `1px solid ${tone.border}`,
                              borderRadius: 999,
                              padding: "8px 12px",
                              fontSize: 12,
                              fontWeight: 700,
                              textTransform: "capitalize",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.status || "blocked"}
                          </span>
                        </div>

                        <div style={blacklistInfoGridStyle}>
                          <MiniInfo label="Keyword" value={item.lastKeyword || "-"} />
                          <MiniInfo label="Reason" value={item.reason || "-"} />
                          <MiniInfo label="Source" value={item.source || "-"} />
                          <MiniInfo label="Updated" value={item.updatedAtLabel || "-"} />
                        </div>

                        <div style={replySectionStyle}>
                          <div style={replySectionTitleStyle}>Replies moved to blacklist tab</div>

                          {phoneReplies.length === 0 ? (
                            <div style={emptyReplyStyle}>
                              No related STOP replies found for this number.
                            </div>
                          ) : (
                            <div style={replyListStyle}>
                              {phoneReplies.map((reply) => (
                                <div key={reply.id} style={replyBubbleStyle}>
                                  <div style={replyHeaderStyle}>
                                    <span style={replyEventChipStyle}>
                                      {reply.eventType || reply.optOutType || "STOP"}
                                    </span>
                                    <span style={replyDateStyle}>
                                      {reply.createdAtLabel || "-"}
                                    </span>
                                  </div>
                                  <div style={replyBodyStyle}>{reply.body || "-"}</div>
                                  <div style={replyIdStyle}>
                                    Reply ID: {truncateMiddle(reply.id, 10, 8)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </section>
        </div>
      </main>
    </>
  );
}

function GlobalStyles() {
  return (
    <style jsx global>{`
      @keyframes spin {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }

      @keyframes toastIn {
        0% {
          opacity: 0;
          transform: translateY(-18px) scale(0.96);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      input::placeholder,
      textarea::placeholder {
        color: rgba(100, 116, 139, 0.9);
      }
    `}</style>
  );
}

function StatCard({
  label,
  value,
  accent,
  compact = false,
}: {
  label: string;
  value: string;
  accent: string;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        background: accent,
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 20,
        padding: "18px 18px",
        backdropFilter: "blur(10px)",
        minHeight: compact ? 88 : 96,
      }}
    >
      <div style={{ color: "rgba(236, 254, 255, 0.72)", fontSize: 13, fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          color: "#ffffff",
          fontSize: compact ? 16 : 28,
          fontWeight: 800,
          lineHeight: 1.15,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MiniInfo({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniInfoCardStyle}>
      <div style={miniInfoLabelStyle}>{label}</div>
      <div style={miniInfoValueStyle}>{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={emptyStateStyle}>
      <div style={emptyStateIconStyle}>•</div>
      <div style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}>{text}</div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(20,184,166,0.18), transparent 28%), linear-gradient(180deg, #ecfeff 0%, #f8fafc 46%, #f8fafc 100%)",
  color: "#0f172a",
};

const pageShellStyle: CSSProperties = {
  width: "100%",
  minHeight: "100vh",
  display: "grid",
  gridTemplateColumns: "290px 1fr",
};

const sidebarStyle: CSSProperties = {
  background: "linear-gradient(180deg, #0f766e 0%, #0b5f59 100%)",
  padding: 24,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  gap: 24,
  position: "sticky",
  top: 0,
  minHeight: "100vh",
  boxShadow: "inset -1px 0 0 rgba(255,255,255,0.08)",
};

const brandWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const brandIconStyle: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 18,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.14)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 22,
  boxShadow: "0 10px 25px rgba(0,0,0,0.18)",
};

const brandTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 20,
  lineHeight: 1.1,
};

const brandSubStyle: CSSProperties = {
  marginTop: 4,
  color: "rgba(236, 254, 255, 0.7)",
  fontSize: 13,
};

const adminMiniCardStyle: CSSProperties = {
  marginTop: 24,
  borderRadius: 22,
  padding: 16,
  background: "rgba(255,255,255,0.09)",
  border: "1px solid rgba(255,255,255,0.12)",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const avatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontWeight: 800,
  fontSize: 18,
  flexShrink: 0,
};

const sidebarSmallLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.68)",
  fontSize: 12,
};

const sidebarAdminNameStyle: CSSProperties = {
  marginTop: 4,
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 800,
};

const sidebarRepliesWrapStyle: CSSProperties = {
  marginTop: 18,
};

const sidebarRepliesCardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  textDecoration: "none",
};

const sidebarSupportCardStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  cursor: "pointer",
};

const sidebarRepliesIconStyle: CSSProperties = {
  width: 54,
  height: 54,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 24,
  fontWeight: 900,
  flexShrink: 0,
};

const sidebarSupportIconStyle: CSSProperties = {
  width: 54,
  height: 54,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 24,
  fontWeight: 900,
  flexShrink: 0,
};

const sidebarRepliesTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.1,
};

const sidebarRepliesTextStyle: CSSProperties = {
  marginTop: 6,
  color: "rgba(236, 254, 255, 0.78)",
  fontSize: 13,
  lineHeight: 1.4,
};

const sidebarBottomLogoutWrapStyle: CSSProperties = {
  display: "grid",
};

const sidebarSecondaryLinkButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 16,
  padding: "14px 16px",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
  textDecoration: "none",
  textAlign: "center",
};

const sidebarLogoutButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 16,
  padding: "14px 16px",
  background: "transparent",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
};

const contentStyle: CSSProperties = {
  padding: 24,
  display: "grid",
  gap: 20,
};

const heroCardStyle: CSSProperties = {
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
  fontSize: 38,
  lineHeight: 1.05,
  fontWeight: 900,
};

const heroTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  maxWidth: 760,
  color: "rgba(236,254,255,0.86)",
  fontSize: 16,
  lineHeight: 1.65,
};

const heroTopControlsStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
};

const searchBarStyle: CSSProperties = {
  flex: 1,
  minWidth: 260,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 16px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.16)",
  backdropFilter: "blur(10px)",
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "#ffffff",
  fontSize: 15,
};

const heroPrimaryButtonLinkStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 14,
};

const panelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
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

const secondaryButtonStyle: CSSProperties = {
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  cursor: "pointer",
};

const blacklistCardsWrapStyle: CSSProperties = {
  marginTop: 18,
  display: "grid",
  gap: 18,
};

const blacklistCardStyle: CSSProperties = {
  borderRadius: 24,
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15,23,42,0.06)",
  padding: 18,
  boxShadow: "0 10px 24px rgba(15,23,42,0.05)",
};

const blacklistCardTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexWrap: "wrap",
};

const blacklistPhoneStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 900,
  color: "#0f172a",
  wordBreak: "break-word",
};

const blacklistMetaStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: "#64748b",
};

const blacklistInfoGridStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 12,
};

const miniInfoCardStyle: CSSProperties = {
  borderRadius: 16,
  background: "#f8fafc",
  padding: 12,
  border: "1px solid #eef2f7",
};

const miniInfoLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  fontWeight: 700,
};

const miniInfoValueStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  color: "#0f172a",
  fontWeight: 800,
  wordBreak: "break-word",
};

const replySectionStyle: CSSProperties = {
  marginTop: 18,
  borderTop: "1px solid #eef2f7",
  paddingTop: 16,
};

const replySectionTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: "#0f172a",
  marginBottom: 12,
};

const emptyReplyStyle: CSSProperties = {
  borderRadius: 16,
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  padding: 16,
  color: "#64748b",
  fontSize: 14,
  fontWeight: 600,
};

const replyListStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const replyBubbleStyle: CSSProperties = {
  borderRadius: 18,
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
  padding: 14,
};

const replyHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

const replyEventChipStyle: CSSProperties = {
  background: "rgba(239, 68, 68, 0.12)",
  color: "#dc2626",
  border: "1px solid rgba(239, 68, 68, 0.25)",
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 700,
};

const replyDateStyle: CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  fontWeight: 700,
};

const replyBodyStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 15,
  lineHeight: 1.6,
  color: "#0f172a",
  wordBreak: "break-word",
};

const replyIdStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  color: "#64748b",
};

const emptyStateStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 22,
  padding: "34px 18px",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  display: "grid",
  justifyItems: "center",
  gap: 10,
  textAlign: "center",
};

const emptyStateIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#e2e8f0",
  color: "#475569",
  fontWeight: 900,
};

const loadingPageStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 50%, #14b8a6 100%)",
};

const loadingCardStyle: CSSProperties = {
  borderRadius: 28,
  padding: "28px 32px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  backdropFilter: "blur(10px)",
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.25)",
  borderTop: "3px solid #ffffff",
  animation: "spin 1s linear infinite",
};

const toastStyle: CSSProperties = {
  position: "fixed",
  top: 24,
  right: 24,
  zIndex: 9999,
  width: "min(560px, calc(100vw - 32px))",
  borderRadius: 26,
  padding: "18px 18px",
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
  boxShadow: "0 30px 80px rgba(2, 8, 23, 0.32)",
  animation: "toastIn 0.28s ease-out",
  border: "1px solid rgba(255,255,255,0.08)",
};

const toastSuccessStyle: CSSProperties = {
  background: "linear-gradient(135deg, #052e2b 0%, #065f46 100%)",
  color: "#ffffff",
};

const toastErrorStyle: CSSProperties = {
  background: "linear-gradient(135deg, #3f0d0d 0%, #991b1b 100%)",
  color: "#ffffff",
};

const toastInfoStyle: CSSProperties = {
  background: "linear-gradient(135deg, #0f172a 0%, #0b2545 100%)",
  color: "#ffffff",
};

const toastDotStyle: CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  flexShrink: 0,
  marginTop: 4,
};

const toastTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  lineHeight: 1.2,
};

const toastMessageStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 15,
  lineHeight: 1.6,
  color: "rgba(255,255,255,0.95)",
};

const toastCloseStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#ffffff",
  fontSize: 24,
  lineHeight: 1,
  cursor: "pointer",
  opacity: 0.85,
};