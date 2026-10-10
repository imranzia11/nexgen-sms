"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { currentNYMonthString } from "../../lib/date";
import LoadingScreen from "../../components/LoadingScreen";
import RepliesNavBadge from "../../components/RepliesNavBadge";
import TwilioBalanceCard from "../../components/TwilioBalanceCard";

// Usage billing for accounts that have a flat per-SMS rate set
// (users/{uid}.billingRatePerSms, written only via tools/set-billing-rate.ts).
// Every SMS sent AND every SMS received is charged at that rate. All numbers
// come from /api/billing, which is scoped to the signed-in caller; accounts
// without a rate are sent back to the dashboard.

type DayRow = { day: number; sent: number; received: number; amount: number };

type BillingData = {
  month: string;
  rate: number;
  sent: number;
  received: number;
  total: number;
  amount: number;
  days: DayRow[];
};

function money(value: number) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatMonthLabel(monthStr: string) {
  const [y, m] = monthStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, 1));
  return dt.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function BillingPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("User");
  const [ready, setReady] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(currentNYMonthString());
  const [data, setData] = useState<BillingData | null>(null);
  const [errorText, setErrorText] = useState("");

  const loadBilling = async (month: string) => {
    try {
      setLoading(true);
      setErrorText("");

      const user = auth.currentUser;
      if (!user) return;

      const idToken = await user.getIdToken();
      const res = await fetch(`/api/billing?month=${encodeURIComponent(month)}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || "Failed to load billing.");
      }

      if (json.enabled !== true) {
        router.push("/dashboard");
        return;
      }

      setData(json as BillingData);
    } catch (error: any) {
      console.error("Failed to load billing", error);
      setErrorText(error?.message || "Failed to load billing.");
    } finally {
      setLoading(false);
    }
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
          await signOut(auth).catch(() => {});
          router.push("/login");
          return;
        }

        const userData = snap.data() as Record<string, any>;
        setUserName(
          String(userData.name || "").trim() ||
            String(user.displayName || "").trim() ||
            String(user.email || "").split("@")[0] ||
            "User"
        );
        setChecking(false);
        setReady(true);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!ready) return;
    loadBilling(selectedMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedMonth]);

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  if (checking) {
    return <LoadingScreen />;
  }

  const activeDays = (data?.days || []).filter((d) => d.sent + d.received > 0);

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
              <TwilioBalanceCard />
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
              <Link
                href="/replies"
                style={{ ...sidebarRepliesCardStyle, position: "relative" }}
              >
                <RepliesNavBadge />
                <div style={sidebarRepliesIconStyle}>↩</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Replies</div>
                  <div style={sidebarRepliesTextStyle}>Open incoming messages</div>
                </div>
              </Link>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/help" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>🎧</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Help Center</div>
                  <div style={sidebarRepliesTextStyle}>Ask a question, get instant help</div>
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
                <div style={heroBadgeStyle}>Your Usage</div>
                <h1 style={heroTitleStyle}>Billing</h1>
                <p style={heroTextStyle}>
                  {data ? money(data.rate) : "Per-message rate"} per SMS, charged on every
                  message sent and every message received.
                </p>
              </div>

              <div style={controlsRowStyle}>
                <input
                  type="month"
                  value={selectedMonth}
                  max={currentNYMonthString()}
                  onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
                  style={monthInputStyle}
                />

                <button
                  onClick={() => loadBilling(selectedMonth)}
                  style={heroPrimaryButtonStyle}
                >
                  Refresh
                </button>
              </div>
            </div>
          </div>

          {errorText ? <div style={errorBoxStyle}>{errorText}</div> : null}

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <h2 style={panelTitleStyle}>{formatMonthLabel(selectedMonth)}</h2>
              <p style={panelDescStyle}>
                {data
                  ? `${data.sent.toLocaleString()} sent + ${data.received.toLocaleString()} received = ${data.total.toLocaleString()} SMS x ${money(data.rate)}`
                  : "Loading usage..."}
              </p>
            </div>

            {loading || !data ? (
              <div style={ringWrapStyle}>
                <div style={spinnerStyle} />
              </div>
            ) : (
              <div style={{ display: "grid", gap: 20 }}>
                <div style={summaryGridStyle}>
                  <div style={summaryTileStyle}>
                    <div style={summaryLabelStyle}>SMS sent</div>
                    <div style={summaryValueStyle}>{data.sent.toLocaleString()}</div>
                    <div style={summarySubStyle}>{money(data.sent * data.rate)}</div>
                  </div>
                  <div style={summaryTileStyle}>
                    <div style={summaryLabelStyle}>SMS received</div>
                    <div style={summaryValueStyle}>{data.received.toLocaleString()}</div>
                    <div style={summarySubStyle}>{money(data.received * data.rate)}</div>
                  </div>
                  <div style={{ ...summaryTileStyle, ...summaryTotalTileStyle }}>
                    <div style={summaryLabelStyle}>Total</div>
                    <div style={summaryValueStyle}>{money(data.amount)}</div>
                    <div style={summarySubStyle}>
                      {data.total.toLocaleString()} x {money(data.rate)}
                    </div>
                  </div>
                </div>

                <div style={{ overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Day</th>
                        <th style={thStyleRight}>Sent</th>
                        <th style={thStyleRight}>Received</th>
                        <th style={thStyleRight}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeDays.length === 0 ? (
                        <tr>
                          <td style={tdStyle} colSpan={4}>
                            No SMS activity this month.
                          </td>
                        </tr>
                      ) : (
                        activeDays.map((row) => (
                          <tr key={row.day}>
                            <td style={tdStyle}>
                              {formatMonthLabel(selectedMonth).split(" ")[0]} {row.day}
                            </td>
                            <td style={tdStyleRight}>{row.sent.toLocaleString()}</td>
                            <td style={tdStyleRight}>{row.received.toLocaleString()}</td>
                            <td style={tdStyleRight}>{money(row.amount)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 14,
};

const summaryTileStyle: CSSProperties = {
  borderRadius: 20,
  padding: "18px 20px",
  background: "rgba(15,118,110,0.08)",
  border: "1px solid rgba(15,118,110,0.18)",
  display: "grid",
  gap: 4,
};

const summaryTotalTileStyle: CSSProperties = {
  background: "rgba(15,118,110,0.16)",
  border: "1px solid rgba(15,118,110,0.35)",
};

const summaryLabelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "#475569",
};

const summaryValueStyle: CSSProperties = {
  fontSize: 30,
  fontWeight: 900,
  color: "#0f172a",
  lineHeight: 1.1,
};

const summarySubStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "#0f766e",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 16,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  color: "#475569",
  fontWeight: 800,
  borderBottom: "1px solid rgba(15,23,42,0.12)",
};

const thStyleRight: CSSProperties = { ...thStyle, textAlign: "right" };

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  color: "#0f172a",
  fontWeight: 600,
  borderBottom: "1px solid rgba(15,23,42,0.06)",
};

const tdStyleRight: CSSProperties = { ...tdStyle, textAlign: "right" };

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
  gridTemplateColumns: "320px 1fr",
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
  fontSize: 15,
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

const comingSoonOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9998,
  background: "rgba(3, 7, 18, 0.52)",
  backdropFilter: "blur(8px)",
  display: "grid",
  placeItems: "center",
  padding: 24,
};

const comingSoonCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 440,
  borderRadius: 30,
  padding: "34px 28px",
  background: "linear-gradient(135deg, #0f2027 0%, #134e4a 100%)",
  boxShadow: "0 30px 100px rgba(2, 8, 23, 0.45)",
  border: "1px solid rgba(255,255,255,0.12)",
  textAlign: "center",
};

const comingSoonIconStyle: CSSProperties = {
  width: 64,
  height: 64,
  margin: "0 auto 16px auto",
  borderRadius: "50%",
  background: "#ccfbf1",
  display: "grid",
  placeItems: "center",
  fontSize: 30,
};

const comingSoonTitleStyle: CSSProperties = {
  margin: 0,
  color: "#ffffff",
  fontSize: 24,
  fontWeight: 900,
  lineHeight: 1.15,
};

const comingSoonTextStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "rgba(226, 232, 240, 0.92)",
  fontSize: 17,
  lineHeight: 1.6,
};

const comingSoonCloseButtonStyle: CSSProperties = {
  marginTop: 22,
  width: "100%",
  border: "none",
  borderRadius: 16,
  padding: "14px 16px",
  background: "#2dd4bf",
  color: "#022c22",
  fontSize: 17,
  fontWeight: 800,
  cursor: "pointer",
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
  fontSize: 13,
};

const sidebarAdminNameStyle: CSSProperties = {
  marginTop: 4,
  color: "#ffffff",
  fontSize: 18,
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
  color: "rgba(236, 254, 255, 0.95)",
  fontSize: 15,
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
  // Sized to its content, not a fixed viewport fraction - the 50vh version
  // left a huge slab of empty green above the actual title/controls, which
  // read as wasted space rather than a "bigger" header.
  display: "flex",
  alignItems: "center",
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
  width: "100%",
  // Roughly half the previous padding/gap - the dashboard-matched version
  // was still a tall green block for a page whose hero only ever holds a
  // title, one line of text, and a month picker.
  padding: 16,
  display: "grid",
  gap: 11,
};

const heroBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  width: "fit-content",
  borderRadius: 999,
  padding: "5px 11px",
  background: "rgba(255,255,255,0.14)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.3,
};

const heroTitleStyle: CSSProperties = {
  margin: "6px 0 0 0",
  color: "#ffffff",
  fontSize: 22,
  lineHeight: 1.1,
  fontWeight: 900,
};

const heroTextStyle: CSSProperties = {
  margin: "5px 0 0 0",
  maxWidth: 760,
  color: "rgba(236,254,255,0.92)",
  fontSize: 15,
  lineHeight: 1.5,
};

const controlsRowStyle: CSSProperties = {
  marginTop: 4,
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

const monthInputStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 12,
  padding: "8px 12px",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 600,
  colorScheme: "dark",
};

const heroPrimaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 12,
  padding: "8px 14px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  cursor: "pointer",
};

const panelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 28,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  display: "grid",
  gap: 18,
};

const panelHeaderStyle: CSSProperties = {
  textAlign: "center",
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
  fontSize: 16,
  lineHeight: 1.5,
};

const ringWrapStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  padding: "12px 0 4px 0",
};

// Full-width bar chart, one bar per day of the month - big enough to read
// at a glance across the whole panel rather than a grid of small tiles.
const barChartWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 10,
  height: 640,
  width: "100%",
  padding: "20px 8px 4px 8px",
};

const barColStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  flex: 1,
  height: "100%",
  minWidth: 0,
};

const barCountStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 900,
  color: "#0f172a",
  height: 30,
};

const barTrackStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  display: "flex",
  alignItems: "flex-end",
  background: "#f4fbf9",
  borderRadius: 8,
  overflow: "hidden",
};

const barFillStyle: CSSProperties = {
  width: "100%",
  background: "linear-gradient(180deg, #14b8a6 0%, #0f766e 100%)",
  borderRadius: 8,
  transition: "height 0.8s ease-out",
};

const barDayLabelStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#64748b",
};

// Clear axis labels around the chart - "SMS Sent" running vertically along
// the left (the y-axis: what the bar heights/numbers represent) and "Day
// of Month" centered under the day numbers (the x-axis) - so the chart
// reads correctly at a glance instead of relying on the panel description
// text alone.
const chartAxisWrapStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  alignItems: "stretch",
};

const yAxisLabelStyle: CSSProperties = {
  writingMode: "vertical-rl",
  transform: "rotate(180deg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#0f172a",
  fontSize: 18,
  fontWeight: 800,
  letterSpacing: 0.4,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const chartMainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "grid",
};

const xAxisLabelStyle: CSSProperties = {
  textAlign: "center",
  marginTop: 10,
  color: "#0f172a",
  fontSize: 18,
  fontWeight: 800,
  letterSpacing: 0.4,
};

const errorBoxStyle: CSSProperties = {
  borderRadius: 18,
  padding: "14px 16px",
  background: "#7f1d1d",
  color: "#ffffff",
  fontSize: 16,
  lineHeight: 1.5,
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(15, 23, 42, 0.15)",
  borderTop: "3px solid #0d9488",
  animation: "spin 1s linear infinite",
};
