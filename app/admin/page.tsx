"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import LoadingScreen from "../../components/LoadingScreen";

type AccountRow = {
  uid: string;
  name: string;
  email: string;
  isActive: boolean;
  twilioNumber: string;
  smsSentCount: number;
};

export default function AdminOverviewPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);

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

        // This page only ever renders cross-account data - anyone who
        // isn't the superadmin gets bounced straight back to their own
        // dashboard, never a blank/error state that hints at what's here.
        if (String(data.role || "").toLowerCase() !== "superadmin") {
          router.push("/dashboard");
          return;
        }

        setChecking(false);

        const idToken = await user.getIdToken();
        const res = await fetch("/api/admin/overview", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const body = await res.json();

        if (!res.ok || !body.ok) {
          setLoadError(body.error || "Failed to load account overview.");
          setLoading(false);
          return;
        }

        setAccounts(body.accounts || []);
        setLoading(false);
      } catch (error: unknown) {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Unexpected error loading account overview."
        );
        setChecking(false);
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  if (checking) {
    return <LoadingScreen text="Checking account access..." />;
  }

  return (
    <main style={pageStyle}>
      <div style={heroStyle}>
        <div style={heroTopRowStyle}>
          <div>
            <div style={heroBadgeStyle}>SUPERADMIN</div>
            <h1 style={heroTitleStyle}>All Accounts</h1>
            <p style={heroSubStyle}>
              Every portal account, monitoring only - click into one for
              login history and SMS volume.
            </p>
          </div>
          <button onClick={handleLogout} style={logoutButtonStyle}>
            Log out
          </button>
        </div>

        <div style={statCardStyle}>
          <div style={statLabelStyle}>Total Accounts</div>
          <div style={statValueStyle}>{accounts.length}</div>
        </div>
      </div>

      <div style={contentStyle}>
        {loading ? (
          <div style={emptyStateStyle}>Loading accounts...</div>
        ) : loadError ? (
          <div style={errorStateStyle}>{loadError}</div>
        ) : accounts.length === 0 ? (
          <div style={emptyStateStyle}>No accounts found.</div>
        ) : (
          <div style={rosterListStyle}>
            {accounts.map((account) => (
              <Link
                key={account.uid}
                href={`/admin/${account.uid}`}
                style={rosterCardStyle}
              >
                <div>
                  <div style={accountNameStyle}>
                    {account.name || "(no name)"}
                  </div>
                  <div style={accountEmailStyle}>{account.email}</div>
                  {account.twilioNumber ? (
                    <div style={accountNumberStyle}>{account.twilioNumber}</div>
                  ) : null}
                </div>

                <div style={rosterRightStyle}>
                  <span
                    style={{
                      ...statusBadgeStyle,
                      ...(account.isActive
                        ? statusActiveStyle
                        : statusInactiveStyle),
                    }}
                  >
                    {account.isActive ? "Active" : "Inactive"}
                  </span>
                  <div style={smsCountWrapStyle}>
                    <div style={smsCountValueStyle}>{account.smsSentCount}</div>
                    <div style={smsCountLabelStyle}>SMS sent</div>
                  </div>
                  <span style={chevronStyle}>&rsaquo;</span>
                </div>
              </Link>
            ))}
          </div>
        )}
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
  maxWidth: 480,
};

const logoutButtonStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.28)",
  background: "rgba(255,255,255,0.12)",
  color: "#ecfeff",
  borderRadius: 999,
  padding: "10px 20px",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const statCardStyle: CSSProperties = {
  marginTop: 28,
  display: "inline-flex",
  flexDirection: "column",
  background: "rgba(255,255,255,0.18)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 20,
  padding: "18px 26px",
  backdropFilter: "blur(10px)",
};

const statLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.72)",
  fontSize: 13,
  fontWeight: 600,
};

const statValueStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 30,
  fontWeight: 800,
  color: "#ffffff",
};

const contentStyle: CSSProperties = {
  maxWidth: 900,
  margin: "36px auto 0",
  padding: "0 24px",
};

const rosterListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const rosterCardStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  background: "#ffffff",
  borderRadius: 18,
  border: "1px solid #e2ede9",
  padding: "18px 22px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.06)",
  textDecoration: "none",
  color: "inherit",
};

const rosterRightStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 20,
};

const accountNameStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 15.5,
  color: "#0f172a",
};

const accountEmailStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 13,
  color: "#64748b",
};

const accountNumberStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 12.5,
  color: "#0f766e",
  fontFamily: "'IBM Plex Mono', monospace",
};

const statusBadgeStyle: CSSProperties = {
  display: "inline-flex",
  padding: "4px 12px",
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 700,
};

const statusActiveStyle: CSSProperties = {
  background: "rgba(16, 185, 129, 0.12)",
  color: "#047857",
};

const statusInactiveStyle: CSSProperties = {
  background: "rgba(220, 38, 38, 0.1)",
  color: "#b91c1c",
};

const smsCountWrapStyle: CSSProperties = {
  textAlign: "right",
  minWidth: 70,
};

const smsCountValueStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 800,
  color: "#0f172a",
};

const smsCountLabelStyle: CSSProperties = {
  fontSize: 11.5,
  color: "#94a3b8",
  fontWeight: 600,
};

const chevronStyle: CSSProperties = {
  fontSize: 24,
  color: "#94a3b8",
};

const emptyStateStyle: CSSProperties = {
  padding: "60px 20px",
  textAlign: "center",
  color: "#64748b",
  fontSize: 15,
};

const errorStateStyle: CSSProperties = {
  padding: "24px 20px",
  textAlign: "center",
  color: "#b91c1c",
  background: "rgba(220, 38, 38, 0.06)",
  borderRadius: 16,
  fontSize: 14.5,
};
