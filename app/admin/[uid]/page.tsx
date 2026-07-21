"use client";

import { use, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import LoadingScreen from "../../../components/LoadingScreen";

type AccountDetail = {
  uid: string;
  name: string;
  email: string;
  isActive: boolean;
  twilioNumber: string;
  smsSentCount: number;
};

type LoginEntry = {
  id: string;
  loginAt: string;
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
  const [lookbackDays, setLookbackDays] = useState(5);
  const [activeTab, setActiveTab] = useState<TabId>("logins");

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
        setLookbackDays(body.lookbackDays || 5);
        setLoading(false);
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
