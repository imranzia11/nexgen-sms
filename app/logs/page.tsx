"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import {
  formatFirestoreDateNY,
  getNYDayRangeUtc,
  todayNYDateString,
} from "../../lib/date";
import LoadingScreen from "../../components/LoadingScreen";

// This page is intentionally simple: every account only ever sees its own
// messages (scoped by ownerUid, matching Firestore's security rules exactly
// — no admin bypass, no cross-account merging), and every message is
// reduced to one of two outcomes so anyone can glance at it and understand
// what happened. Anything still in flight (queued/sending) is left out of
// the list rather than shown as a third, confusing state.

type Outcome = "success" | "failed";

type MessageLogItem = {
  id: string;
  to: string;
  body: string;
  outcome: Outcome;
  error: string;
  createdAtLabel: string;
  sortMs: number;
};

type AppUser = {
  uid: string;
  isActive: boolean;
  email?: string;
  name?: string;
};

function truncateText(value: string, max = 120) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function toSortMs(value: any) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value?.seconds && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  return 0;
}

function normalizeStatus(status?: string) {
  return String(status || "").trim().toLowerCase();
}

function isSuccessfulStatus(status?: string) {
  const value = normalizeStatus(status);
  return value === "delivered" || value === "sent";
}

function isFailedStatus(status?: string) {
  const value = normalizeStatus(status);
  return value === "failed" || value === "undelivered" || value === "error";
}

function outcomeOf(status?: string): Outcome | null {
  if (isSuccessfulStatus(status)) return "success";
  if (isFailedStatus(status)) return "failed";
  return null; // still processing (queued/sending/etc) — deliberately hidden
}

export default function LogsPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("User");
  const [profile, setProfile] = useState<AppUser | null>(null);

  const [messages, setMessages] = useState<MessageLogItem[]>([]);
  const [search, setSearch] = useState("");
  const [errorText, setErrorText] = useState("");
  const [selectedDate, setSelectedDate] = useState(() => todayNYDateString());

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

        const userData = snap.data() as Record<string, any>;

        const safeProfile: AppUser = {
          uid: user.uid,
          isActive: userData.isActive === true,
          email: String(userData.email || user.email || ""),
          name: String(userData.name || ""),
        };

        const safeName =
          String(userData.name || "").trim() ||
          String(user.displayName || "").trim() ||
          String(user.email || "").split("@")[0] ||
          "User";

        setUserName(safeName);
        setProfile(safeProfile);
        setChecking(false);
        await loadLogs(safeProfile, selectedDate);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Reload whenever the selected day changes (after the initial profile
  // load above has already fired once for the default "today").
  useEffect(() => {
    if (!profile) return;
    loadLogs(profile, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const loadLogs = async (profileArg?: AppUser, dateStr?: string) => {
    try {
      setLoading(true);
      setErrorText("");

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setMessages([]);
        return;
      }

      const { start, end } = getNYDayRangeUtc(dateStr || selectedDate);

      // Single, owner-scoped query — matches the security rules exactly,
      // so it can never fail with permission-denied and can never show
      // one account's messages to another. Range-filtered to just the
      // selected day (NY calendar day, midnight to midnight).
      const snap = await getDocs(
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("createdAt", ">=", start),
          where("createdAt", "<", end),
          orderBy("createdAt", "desc"),
          limit(300)
        )
      );

      const rows: MessageLogItem[] = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, any>;
          const outcome = outcomeOf(data.status);

          if (!outcome) return null;

          return {
            id: d.id,
            to: data.to || "-",
            body: data.body || "",
            outcome,
            error: data.error || "",
            createdAtLabel: formatFirestoreDateNY(data.createdAt),
            sortMs: toSortMs(data.createdAt),
          };
        })
        .filter((row): row is MessageLogItem => row !== null)
        .sort((a, b) => b.sortMs - a.sortMs);

      setMessages(rows);
    } catch (error: any) {
      console.error("Failed to load logs", error);
      setErrorText(error?.message || "Failed to load logs.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  const filteredMessages = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return messages;

    return messages.filter((item) => {
      return (
        item.to.toLowerCase().includes(term) ||
        item.body.toLowerCase().includes(term) ||
        item.outcome.includes(term)
      );
    });
  }, [messages, search]);

  const totalMessages = messages.length;
  const totalSuccess = messages.filter((m) => m.outcome === "success").length;
  const totalFailed = messages.filter((m) => m.outcome === "failed").length;

  if (checking || loading) {
    return <LoadingScreen text="Loading logs..." />;
  }

  return (
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
                {userName?.slice(0, 1)?.toUpperCase() || "U"}
              </div>
              <div>
                <div style={sidebarSmallLabelStyle}>Signed in as</div>
                <div style={sidebarAdminNameStyle}>{userName}</div>
              </div>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/dashboard" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>⌂</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Dashboard</div>
                  <div style={sidebarRepliesTextStyle}>Back to SMS control center</div>
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
              <Link href="/blacklisted" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>⛔</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Blacklisted</div>
                  <div style={sidebarRepliesTextStyle}>View blocked numbers</div>
                </div>
              </Link>
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
                <div style={heroBadgeStyle}>Activity Center</div>
                <h1 style={heroTitleStyle}>Logs</h1>
                <p style={heroTextStyle}>
                  Your own message history — every send, marked simply as
                  Success or Failed.
                </p>
              </div>

              <div style={heroTopControlsStyle}>
                <div style={searchBarStyle}>
                  <span style={{ fontSize: 16, opacity: 0.8 }}>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search phone or message"
                    style={searchInputStyle}
                  />
                </div>

                <input
                  type="date"
                  value={selectedDate}
                  max={todayNYDateString()}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  style={dateInputStyle}
                />

                <button
                  onClick={() => loadLogs(undefined, selectedDate)}
                  style={heroPrimaryButtonStyle}
                >
                  Refresh Logs
                </button>
              </div>

              <div style={statsGridStyle}>
                <StatCard label="Total Messages" value={String(totalMessages)} />
                <StatCard label="Success" value={String(totalSuccess)} accentGood />
                <StatCard label="Failed" value={String(totalFailed)} accentBad />
              </div>
            </div>
          </div>

          {errorText ? <div style={errorBoxStyle}>{errorText}</div> : null}

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Message Logs</h2>
                <p style={panelDescStyle}>
                  Showing {selectedDate === todayNYDateString() ? "today" : selectedDate}.
                  Only finished messages are shown — nothing still sending.
                </p>
              </div>
            </div>

            {filteredMessages.length === 0 ? (
              <EmptyState text="No message logs found." />
            ) : (
              <div style={cardGridStyle}>
                {filteredMessages.map((item) => {
                  const isSuccess = item.outcome === "success";

                  return (
                    <div key={item.id} style={logCardStyle}>
                      <div style={logCardTopStyle}>
                        <div style={{ minWidth: 0 }}>
                          <div style={logTitleStyle}>{item.to}</div>
                          <div style={logBodyStyle}>
                            {truncateText(item.body || "-", 140)}
                          </div>
                        </div>

                        <span
                          style={{
                            ...outcomeChipStyle,
                            ...(isSuccess ? successChipStyle : failedChipStyle),
                          }}
                        >
                          {isSuccess ? "Success" : "Failed"}
                        </span>
                      </div>

                      <div style={logMetaRowStyle}>
                        <span>{item.createdAtLabel}</span>
                        {!isSuccess && item.error ? (
                          <span style={logErrorTextStyle}>
                            {truncateText(item.error, 100)}
                          </span>
                        ) : null}
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
  );
}

function StatCard({
  label,
  value,
  accentGood,
  accentBad,
}: {
  label: string;
  value: string;
  accentGood?: boolean;
  accentBad?: boolean;
}) {
  return (
    <div
      style={{
        ...statCardStyle,
        ...(accentGood ? statCardGoodStyle : accentBad ? statCardBadStyle : null),
      }}
    >
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
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

const dateInputStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 18,
  padding: "14px 16px",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 600,
  colorScheme: "dark",
};

const heroPrimaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  cursor: "pointer",
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 14,
};

const statCardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.18)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 20,
  padding: "18px 18px",
  backdropFilter: "blur(10px)",
};

const statCardGoodStyle: CSSProperties = {
  background: "rgba(16, 185, 129, 0.22)",
  border: "1px solid rgba(16, 185, 129, 0.3)",
};

const statCardBadStyle: CSSProperties = {
  background: "rgba(239, 68, 68, 0.22)",
  border: "1px solid rgba(239, 68, 68, 0.3)",
};

const statLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.72)",
  fontSize: 13,
  fontWeight: 600,
};

const statValueStyle: CSSProperties = {
  marginTop: 10,
  color: "#ffffff",
  fontSize: 30,
  fontWeight: 800,
  lineHeight: 1.15,
  wordBreak: "break-word",
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

const errorBoxStyle: CSSProperties = {
  borderRadius: 18,
  padding: "14px 16px",
  background: "#7f1d1d",
  color: "#ffffff",
  fontSize: 14,
  lineHeight: 1.5,
};

const cardGridStyle: CSSProperties = {
  marginTop: 18,
  display: "grid",
  gap: 14,
};

const logCardStyle: CSSProperties = {
  borderRadius: 22,
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15,23,42,0.06)",
  padding: 16,
  boxShadow: "0 10px 24px rgba(15,23,42,0.05)",
};

const logCardTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
  flexWrap: "wrap",
};

const logTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 900,
  color: "#0f172a",
  wordBreak: "break-word",
};

const logBodyStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 14,
  color: "#475569",
  lineHeight: 1.5,
  wordBreak: "break-word",
};

const logMetaRowStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  fontSize: 12,
  color: "#94a3b8",
  fontWeight: 600,
};

const logErrorTextStyle: CSSProperties = {
  color: "#dc2626",
};

const outcomeChipStyle: CSSProperties = {
  borderRadius: 999,
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const successChipStyle: CSSProperties = {
  background: "rgba(16, 185, 129, 0.12)",
  color: "#059669",
  border: "1px solid rgba(16, 185, 129, 0.25)",
};

const failedChipStyle: CSSProperties = {
  background: "rgba(239, 68, 68, 0.12)",
  color: "#dc2626",
  border: "1px solid rgba(239, 68, 68, 0.25)",
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

