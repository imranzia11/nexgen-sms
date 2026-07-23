"use client";

import { use, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { nyDateKey } from "@/lib/date";
import LoadingScreen from "../../../components/LoadingScreen";

type AccountDetail = {
  uid: string;
  name: string;
  email: string;
  isActive: boolean;
  twilioNumber: string;
  smsSentCount: number;
  todaySentCount: number;
};

type LoginEntry = {
  id: string;
  loginAt: string;
};

type DailySentCount = {
  date: string;
  count: number;
};

type TabId = "logins" | "sms";

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function nyShortLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

// Builds one bar per day for the lookback window (oldest first), even for
// days with zero logins, so the graph always shows a full, evenly-spaced
// window instead of silently compressing around whichever days happened
// to have activity.
function buildLoginActivity(loginHistory: LoginEntry[], lookbackDays: number) {
  const countsByDay = new Map<string, number>();

  loginHistory.forEach((entry) => {
    const d = new Date(entry.loginAt);
    if (Number.isNaN(d.getTime())) return;
    const key = nyDateKey(d);
    countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
  });

  const days: { key: string; label: string; count: number }[] = [];
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = nyDateKey(d);
    days.push({
      key,
      label: nyShortLabel(d),
      count: countsByDay.get(key) || 0,
    });
  }
  return days;
}

// dailySentCounts already comes back from the API pre-bucketed (oldest
// first, one entry per day, zero-filled) - this just attaches a display
// label per day, using the same date-key -> label conversion as the login
// chart so the two charts read consistently.
function buildSentActivity(dailySentCounts: DailySentCount[]) {
  return dailySentCounts.map((entry) => {
    const [y, m, d] = entry.date.split("-").map((part) => Number(part));
    // Noon avoids any DST-edge rollover when re-deriving the label from a
    // pure calendar-date string that carries no time-of-day of its own.
    const dateForLabel = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0));
    return {
      key: entry.date,
      label: nyShortLabel(dateForLabel),
      count: entry.count,
    };
  });
}

const RING_RADIUS = 66;
const RING_STROKE = 13;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function StatRing({
  label,
  value,
  revealed,
  accent,
}: {
  label: string;
  value: number;
  revealed: boolean;
  accent: string;
}) {
  // Purely a visual flourish (no real "target" a send count is measured
  // against) - the ring always draws fully around on reveal, matching the
  // exact same decorative pattern already used on the /stats page's
  // "Messages Sent" ring, just smaller so two fit side by side here.
  const dashOffset = revealed ? 0 : RING_CIRCUMFERENCE;

  return (
    <div style={ringCardStyle}>
      <svg width={168} height={168} viewBox="0 0 168 168">
        <circle
          cx={84}
          cy={84}
          r={RING_RADIUS}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={RING_STROKE}
        />
        <circle
          cx={84}
          cy={84}
          r={RING_RADIUS}
          fill="none"
          stroke={accent}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 84 84)"
          style={{ transition: "stroke-dashoffset 1.1s ease-out" }}
        />
        <text
          x={84}
          y={80}
          textAnchor="middle"
          style={{ fontSize: 30, fontWeight: 900, fill: "#0f172a" }}
        >
          {value}
        </text>
        <text
          x={84}
          y={102}
          textAnchor="middle"
          style={{ fontSize: 11, fontWeight: 700, fill: "#64748b" }}
        >
          SMS
        </text>
      </svg>
      <div style={ringLabelStyle}>{label}</div>
    </div>
  );
}

function LoginActivityChart({
  days,
}: {
  days: { key: string; label: string; count: number }[];
}) {
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  return (
    <div style={chartWrapStyle}>
      {days.map((day) => {
        const heightPct = (day.count / maxCount) * 100;
        return (
          <div key={day.key} style={chartColStyle}>
            <div style={chartBarTrackStyle}>
              <div
                style={{
                  ...chartBarFillStyle,
                  height: `${Math.max(day.count > 0 ? 6 : 0, heightPct)}%`,
                }}
              />
            </div>
            <div style={chartCountStyle}>{day.count}</div>
            <div style={chartLabelStyle}>{day.label}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminAccountDetailPage({
  params,
}: {
  params: Promise<{ uid: string }>;
}) {
  const router = useRouter();
  const resolved = use(params);
  const targetUid = resolved.uid;

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [loginHistory, setLoginHistory] = useState<LoginEntry[]>([]);
  const [dailySentCounts, setDailySentCounts] = useState<DailySentCount[]>([]);
  const [lookbackDays, setLookbackDays] = useState(5);
  const [activeTab, setActiveTab] = useState<TabId>("logins");
  const [revealed, setRevealed] = useState(false);

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

        const idToken = await user.getIdToken();
        const res = await fetch(`/api/admin/account/${targetUid}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const body = await res.json();

        if (!res.ok || !body.ok) {
          setLoadError(body.error || "Failed to load account detail.");
          setLoading(false);
          return;
        }

        setAccount(body.account || null);
        setLoginHistory(body.loginHistory || []);
        setDailySentCounts(body.dailySentCounts || []);
        setLookbackDays(body.lookbackDays || 5);
        setLoading(false);

        // Same reveal-after-paint trick as the /stats page ring - lets the
        // browser paint the "empty" ring first so the 0 -> full animation
        // is visible instead of collapsing into an instant jump.
        window.setTimeout(() => setRevealed(true), 60);
      } catch (error: unknown) {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Unexpected error loading account detail."
        );
        setChecking(false);
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router, targetUid]);

  if (checking) {
    return <LoadingScreen text="Checking account access..." />;
  }

  return (
    <main style={pageStyle}>
      <div style={heroStyle}>
        <Link href="/admin" style={backLinkStyle}>
          &lsaquo; All Accounts
        </Link>

        {loading ? (
          <div style={heroLoadingStyle}>Loading account...</div>
        ) : loadError ? (
          <div style={heroLoadingStyle}>{loadError}</div>
        ) : account ? (
          <>
            <h1 style={heroTitleStyle}>{account.name || "(no name)"}</h1>
            <p style={heroSubStyle}>{account.email}</p>
            <div style={heroMetaRowStyle}>
              <span
                style={{
                  ...statusBadgeStyle,
                  ...(account.isActive ? statusActiveStyle : statusInactiveStyle),
                }}
              >
                {account.isActive ? "Active" : "Inactive"}
              </span>
              {account.twilioNumber ? (
                <span style={twilioBadgeStyle}>{account.twilioNumber}</span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div style={contentStyle}>
        {!loading && !loadError && account ? (
          <>
            <div style={ringsRowStyle}>
              <StatRing
                label="Sent Today"
                value={account.todaySentCount}
                revealed={revealed}
                accent="#14b8a6"
              />
              <StatRing
                label="Total Sent"
                value={account.smsSentCount}
                revealed={revealed}
                accent="#0f766e"
              />
            </div>

            <div style={panelStyle}>
              <div style={panelTitleStyle}>
                SMS sent per day - last {dailySentCounts.length || lookbackDays} days
              </div>
              <LoginActivityChart days={buildSentActivity(dailySentCounts)} />
            </div>

            <div style={panelStyle}>
              <div style={panelTitleStyle}>
                Login activity - last {lookbackDays} days
              </div>
              <LoginActivityChart
                days={buildLoginActivity(loginHistory, lookbackDays)}
              />
            </div>

            <div style={tabRowStyle}>
              <button
                onClick={() => setActiveTab("logins")}
                style={{
                  ...tabButtonStyle,
                  ...(activeTab === "logins" ? tabButtonActiveStyle : null),
                }}
              >
                Login History
              </button>
              <button
                onClick={() => setActiveTab("sms")}
                style={{
                  ...tabButtonStyle,
                  ...(activeTab === "sms" ? tabButtonActiveStyle : null),
                }}
              >
                SMS Sent
              </button>
            </div>

            <div style={panelStyle}>
              {activeTab === "logins" ? (
                <>
                  <div style={panelTitleStyle}>
                    Logins in the last {lookbackDays} days
                  </div>
                  {loginHistory.length === 0 ? (
                    <div style={emptyStateStyle}>
                      No logins recorded in this window.
                    </div>
                  ) : (
                    <div style={loginListStyle}>
                      {loginHistory.map((entry) => (
                        <div key={entry.id} style={loginRowStyle}>
                          <span style={loginDotStyle} />
                          {formatDateTime(entry.loginAt)}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={panelTitleStyle}>Total SMS Sent</div>
                  <div style={smsBigNumberStyle}>{account.smsSentCount}</div>
                </>
              )}
            </div>
          </>
        ) : null}
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

const heroLoadingStyle: CSSProperties = {
  marginTop: 20,
  color: "#ecfeff",
  fontSize: 15,
};

const heroTitleStyle: CSSProperties = {
  margin: "18px 0 0 0",
  fontSize: 30,
  fontWeight: 800,
  color: "#ffffff",
};

const heroSubStyle: CSSProperties = {
  margin: "6px 0 0 0",
  fontSize: 14.5,
  color: "rgba(236, 254, 255, 0.8)",
};

const heroMetaRowStyle: CSSProperties = {
  marginTop: 14,
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const statusBadgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "4px 12px",
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 700,
};

const statusActiveStyle: CSSProperties = {
  background: "rgba(255,255,255,0.2)",
  color: "#ffffff",
};

const statusInactiveStyle: CSSProperties = {
  background: "rgba(220, 38, 38, 0.25)",
  color: "#ffffff",
};

const twilioBadgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "4px 12px",
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 700,
  background: "rgba(255,255,255,0.14)",
  color: "#ecfeff",
  fontFamily: "'IBM Plex Mono', monospace",
};

const contentStyle: CSSProperties = {
  maxWidth: 700,
  margin: "-16px auto 0",
  padding: "0 24px",
};

const ringsRowStyle: CSSProperties = {
  display: "flex",
  gap: 20,
  flexWrap: "wrap",
};

const ringCardStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 24,
  border: "1px solid #e2ede9",
  padding: "20px 24px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.08)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  flex: "1 1 200px",
};

const ringLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#5b6b76",
};

const chartWrapStyle: CSSProperties = {
  marginTop: 18,
  display: "flex",
  alignItems: "flex-end",
  gap: 14,
  height: 140,
};

const chartColStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  flex: 1,
  height: "100%",
};

const chartBarTrackStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  maxWidth: 36,
  display: "flex",
  alignItems: "flex-end",
  background: "#f4fbf9",
  borderRadius: 10,
  overflow: "hidden",
};

const chartBarFillStyle: CSSProperties = {
  width: "100%",
  background: "linear-gradient(180deg, #14b8a6 0%, #0f766e 100%)",
  borderRadius: 10,
  transition: "height 0.8s ease-out",
};

const chartCountStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#0f172a",
};

const chartLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#94a3b8",
};

const tabRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  background: "#ffffff",
  borderRadius: 999,
  border: "1px solid #e2ede9",
  padding: 6,
  width: "fit-content",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.08)",
};

const tabButtonStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  borderRadius: 999,
  padding: "10px 20px",
  fontSize: 14,
  fontWeight: 700,
  color: "#5b6b76",
  cursor: "pointer",
};

const tabButtonActiveStyle: CSSProperties = {
  background: "#0f766e",
  color: "#ffffff",
};

const panelStyle: CSSProperties = {
  marginTop: 20,
  background: "#ffffff",
  borderRadius: 20,
  border: "1px solid #e2ede9",
  padding: "26px 28px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.08)",
};

const panelTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#5b6b76",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const loginListStyle: CSSProperties = {
  marginTop: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const loginRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 14.5,
  color: "#0f172a",
  padding: "10px 14px",
  borderRadius: 12,
  background: "#f4fbf9",
};

const loginDotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#0f766e",
  flexShrink: 0,
};

const smsBigNumberStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 56,
  fontWeight: 800,
  color: "#0f172a",
};

const emptyStateStyle: CSSProperties = {
  marginTop: 16,
  padding: "30px 10px",
  textAlign: "center",
  color: "#94a3b8",
  fontSize: 14.5,
};
