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
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";

type LogItem = {
  id: string;
  campaignName?: string;
  fileName?: string;
  name?: string;
  to: string;
  body?: string;
  status?: string;
  error?: string;
  code?: number | null;
  sid?: string;
  direction?: string;
  createdAtLabel: string;
};

function formatFirestoreDate(value: any) {
  try {
    if (!value) return "-";
    if (typeof value?.toDate === "function") {
      return value.toDate().toLocaleString();
    }
    return "-";
  } catch {
    return "-";
  }
}

function truncateText(value: string, max = 100) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function statusTone(status?: string) {
  const value = String(status || "").toLowerCase();

  if (
    value.includes("delivered") ||
    value.includes("sent") ||
    value.includes("queued") ||
    value.includes("accepted") ||
    value.includes("scheduled") ||
    value.includes("sending")
  ) {
    return {
      bg: "rgba(16, 185, 129, 0.12)",
      text: "#059669",
      border: "rgba(16, 185, 129, 0.25)",
    };
  }

  if (value.includes("failed") || value.includes("undelivered") || value.includes("error")) {
    return {
      bg: "rgba(239, 68, 68, 0.12)",
      text: "#dc2626",
      border: "rgba(239, 68, 68, 0.25)",
    };
  }

  return {
    bg: "rgba(59, 130, 246, 0.12)",
    text: "#2563eb",
    border: "rgba(59, 130, 246, 0.25)",
  };
}

export default function LogsPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [adminName, setAdminName] = useState("Admin");
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      const snap = await getDoc(doc(db, "users", user.uid));

      if (!snap.exists() || snap.data().role !== "admin") {
        await signOut(auth);
        router.push("/login");
        return;
      }

      setAdminName(snap.data().name || "Admin");
      setChecking(false);
    });

    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (checking) return;

    const q = query(
      collection(db, "messages"),
      orderBy("createdAt", "desc"),
      limit(300)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: LogItem[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            campaignName: data.campaignName || "",
            fileName: data.fileName || "",
            name: data.name || "",
            to: data.to || "",
            body: data.body || "",
            status: data.status || "",
            error: data.error || "",
            code: data.code ?? null,
            sid: data.sid || data.twilioSid || "",
            direction: data.direction || "",
            createdAtLabel: formatFirestoreDate(data.createdAt),
          };
        });

        setLogs(rows);
        setLoading(false);
      },
      (error) => {
        console.error("Failed to load logs", error);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [checking]);

  const handleLogout = async () => {
    await signOut(auth);
    router.push("/login");
  };

  const filteredLogs = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return logs;

    return logs.filter((item) => {
      return (
        String(item.to || "").toLowerCase().includes(term) ||
        String(item.name || "").toLowerCase().includes(term) ||
        String(item.status || "").toLowerCase().includes(term) ||
        String(item.error || "").toLowerCase().includes(term) ||
        String(item.campaignName || "").toLowerCase().includes(term) ||
        String(item.fileName || "").toLowerCase().includes(term)
      );
    });
  }, [logs, search]);

  const successCount = logs.filter((l) => {
    const s = String(l.status || "").toLowerCase();
    return (
      s === "sent" ||
      s === "delivered" ||
      s === "queued" ||
      s === "accepted" ||
      s === "scheduled" ||
      s === "sending"
    );
  }).length;

  const failedCount = logs.filter((l) => {
    const s = String(l.status || "").toLowerCase();
    return s === "failed" || s === "undelivered" || !!l.error;
  }).length;

  if (checking) {
    return (
      <main style={loadingPageStyle}>
        <div style={loadingCardStyle}>
          <div style={spinnerStyle} />
          <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#e6fffb" }}>
            Checking admin access...
          </p>
        </div>
      </main>
    );
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
                <div style={brandSubStyle}>Admin Portal</div>
              </div>
            </div>

            <div style={adminMiniCardStyle}>
              <div style={avatarStyle}>
                {adminName?.slice(0, 1)?.toUpperCase() || "A"}
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
                  <div style={sidebarRepliesTextStyle}>Go back to SMS dashboard</div>
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
                  <div style={sidebarRepliesTitleStyle}>Black Listed</div>
                  <div style={sidebarRepliesTextStyle}>STOP opt-out numbers</div>
                </div>
              </Link>
            </div>
          </div>

          <div style={sidebarBottomLogoutWrapStyle}>
            <div style={{ display: "grid", gap: 12 }}>
              <Link href="/logs" style={sidebarLogsButtonStyle}>
                Logs
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
                <div style={heroBadgeStyle}>Campaign Monitoring</div>
                <h1 style={heroTitleStyle}>SMS Logs</h1>
                <p style={heroTextStyle}>
                  Monitor all successful and failed SMS sends, including failure reasons and error codes.
                </p>
              </div>

              <div style={heroTopControlsStyle}>
                <div style={searchBarStyle}>
                  <span style={{ fontSize: 16, opacity: 0.8 }}>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by phone, name, campaign, status, or error"
                    style={searchInputStyle}
                  />
                </div>

                <Link href="/dashboard" style={heroPrimaryButtonStyle}>
                  Back to Dashboard
                </Link>
              </div>

              <div style={statsGridStyle}>
                <StatCard
                  label="Total Logs"
                  value={String(logs.length)}
                  accent="rgba(255,255,255,0.18)"
                />
                <StatCard
                  label="Successful SMS"
                  value={String(successCount)}
                  accent="rgba(255,255,255,0.18)"
                />
                <StatCard
                  label="Failed SMS"
                  value={String(failedCount)}
                  accent="rgba(255,255,255,0.18)"
                />
                <StatCard
                  label="Visible Results"
                  value={String(filteredLogs.length)}
                  accent="rgba(255,255,255,0.18)"
                />
              </div>
            </div>
          </div>

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Delivery Logs</h2>
                <p style={panelDescStyle}>
                  Review sent and failed messages with reasons and Twilio codes.
                </p>
              </div>

              <button onClick={() => window.location.reload()} style={secondaryButtonStyle}>
                Refresh
              </button>
            </div>

            {loading ? (
              <EmptyState text="Loading logs..." />
            ) : filteredLogs.length === 0 ? (
              <EmptyState text="No logs found." />
            ) : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Time</th>
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>Phone</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Campaign</th>
                      <th style={thStyle}>Message</th>
                      <th style={thStyle}>Reason</th>
                      <th style={thStyle}>Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.map((item) => {
                      const tone = statusTone(item.status);
                      return (
                        <tr key={item.id}>
                          <td style={tdStyle}>{item.createdAtLabel}</td>
                          <td style={tdStyle}>{item.name || "-"}</td>
                          <td style={tdStyle}>{item.to || "-"}</td>
                          <td style={tdStyle}>
                            <span
                              style={{
                                background: tone.bg,
                                color: tone.text,
                                border: `1px solid ${tone.border}`,
                                borderRadius: 999,
                                padding: "6px 10px",
                                fontSize: 12,
                                fontWeight: 700,
                                textTransform: "capitalize",
                              }}
                            >
                              {item.status || "unknown"}
                            </span>
                          </td>
                          <td style={tdStyle}>{item.campaignName || item.fileName || "-"}</td>
                          <td style={tdStyle}>{truncateText(item.body || "-", 70)}</td>
                          <td style={tdStyle}>{item.error || "-"}</td>
                          <td style={tdStyle}>{item.code ?? "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div
      style={{
        background: accent,
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 20,
        padding: "18px 18px",
        backdropFilter: "blur(10px)",
        minHeight: 96,
      }}
    >
      <div style={{ color: "rgba(236, 254, 255, 0.72)", fontSize: 13, fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          color: "#ffffff",
          fontSize: 28,
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

const sidebarBottomLogoutWrapStyle: CSSProperties = {
  display: "grid",
};

const sidebarLogsButtonStyle: CSSProperties = {
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

const heroPrimaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  textDecoration: "none",
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

const tableWrapStyle: CSSProperties = {
  marginTop: 18,
  overflowX: "auto",
  borderRadius: 20,
  border: "1px solid #eef2f7",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#ffffff",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "14px 16px",
  background: "#f8fafc",
  color: "#475569",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 13,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "14px 16px",
  color: "#0f172a",
  borderBottom: "1px solid #f1f5f9",
  fontSize: 14,
  verticalAlign: "middle",
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