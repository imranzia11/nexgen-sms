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

type BillingCategory = {
  category: string;
  description: string;
  spend: number;
  unit: string;
  count: string;
};

type DaySpend = {
  date: string;
  total: number;
  carrierFees: number;
  currency: string;
};

type Billing = {
  balance: { amount: number; currency: string };
  monthToDate: { total: number; currency: string; byCategory: BillingCategory[] };
  today: DaySpend | null;
  yesterday: DaySpend | null;
  dailySpend: DaySpend[];
  carrierNote: string;
};

function formatDayLabel(dateKey: string) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase() || "USD",
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export default function AdminOverviewPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [billingError, setBillingError] = useState("");

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
        const [res, billingRes] = await Promise.all([
          fetch("/api/admin/overview", {
            headers: { Authorization: `Bearer ${idToken}` },
          }),
          // Fetched alongside the roster, but kept on its own error state -
          // a Twilio API hiccup here shouldn't block the account list from
          // rendering, and vice versa.
          fetch("/api/admin/twilio-billing", {
            headers: { Authorization: `Bearer ${idToken}` },
          }),
        ]);
        const body = await res.json();
        const billingBody = await billingRes.json();

        if (!res.ok || !body.ok) {
          setLoadError(body.error || "Failed to load account overview.");
          setLoading(false);
          return;
        }

        setAccounts(body.accounts || []);
        setLoading(false);

        if (billingRes.ok && billingBody.ok) {
          setBilling({
            balance: billingBody.balance,
            monthToDate: billingBody.monthToDate,
            today: billingBody.today,
            yesterday: billingBody.yesterday,
            dailySpend: billingBody.dailySpend || [],
            carrierNote: billingBody.carrierNote || "",
          });
        } else {
          setBillingError(billingBody.error || "Failed to load Twilio billing.");
        }
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

  const activeCount = accounts.filter((a) => a.isActive).length;
  const inactiveCount = accounts.length - activeCount;

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
          <div style={heroActionsStyle}>
            <Link href="/admin/broadcast" style={diagnoseLinkStyle}>
              Send Update
            </Link>
            <Link href="/admin/diagnose" style={diagnoseLinkStyle}>
              Diagnose Follow-Ups
            </Link>
            <button onClick={handleLogout} style={logoutButtonStyle}>
              Log out
            </button>
          </div>
        </div>

        <div style={statsRowStyle}>
          <div style={heroStatCardStyle}>
            <div style={heroStatIconStyle}>●</div>
            <div>
              <div style={statLabelStyle}>Active Accounts</div>
              <div style={heroStatValueStyle}>{activeCount}</div>
            </div>
          </div>

          <div style={statCardStyle}>
            <div style={statLabelStyle}>Total Accounts</div>
            <div style={statValueStyle}>{accounts.length}</div>
          </div>

          {inactiveCount > 0 ? (
            <div style={statCardStyle}>
              <div style={statLabelStyle}>Inactive</div>
              <div style={statValueStyle}>{inactiveCount}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div style={contentStyle}>
        {billing ? (
          <div style={billingPanelStyle}>
            <div style={billingHeaderRowStyle}>
              <div>
                <div style={billingTitleStyle}>Twilio billing</div>
                <div style={billingSubStyle}>
                  One shared Twilio account across every rep - not broken
                  out per account.
                </div>
              </div>
              <div style={billingSnapshotStyle}>
                <div>
                  <div style={statLabelStyle}>Balance</div>
                  <div style={billingBalanceValueStyle}>
                    {formatMoney(billing.balance.amount, billing.balance.currency)}
                  </div>
                </div>
                <div>
                  <div style={statLabelStyle}>Spent this month</div>
                  <div style={billingBalanceValueStyle}>
                    {formatMoney(
                      billing.monthToDate.total,
                      billing.monthToDate.currency
                    )}
                  </div>
                </div>
              </div>
            </div>

            {billing.monthToDate.byCategory.length > 0 ? (
              <div style={billingCategoryListStyle}>
                {billing.monthToDate.byCategory.map((row) => (
                  <div key={row.category} style={billingCategoryRowStyle}>
                    <span style={billingCategoryLabelStyle}>
                      {row.description || row.category}
                    </span>
                    <span style={billingCategoryValueStyle}>
                      {formatMoney(row.spend, row.unit)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {billing.dailySpend.length > 0 ? (
              <div style={dailyStripSectionStyle}>
                <div style={dailyStripHeaderRowStyle}>
                  <span style={dailyStripTitleStyle}>Daily SMS bill</span>
                  <span style={dailyStripTodayValueStyle}>
                    Today: {billing.today ? formatMoney(billing.today.total, billing.today.currency) : "$0.00"}
                    {" · "}
                    Yesterday: {billing.yesterday ? formatMoney(billing.yesterday.total, billing.yesterday.currency) : "$0.00"}
                  </span>
                </div>
                <div style={dailyStripRowStyle}>
                  {billing.dailySpend.map((day) => (
                    <div key={day.date} style={dailyStripDayStyle}>
                      <div style={dailyStripDayLabelStyle}>{formatDayLabel(day.date)}</div>
                      <div style={dailyStripDayValueStyle}>{formatMoney(day.total, day.currency)}</div>
                      <div style={dailyStripCarrierValueStyle}>
                        {formatMoney(day.carrierFees, day.currency)} carrier
                      </div>
                    </div>
                  ))}
                </div>
                {billing.carrierNote ? (
                  <div style={carrierNoteStyle}>{billing.carrierNote}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : billingError ? (
          <div style={errorStateStyle}>{billingError}</div>
        ) : null}

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
  background: "radial-gradient(circle at 85% 75%, rgba(20,184,166,0.38), transparent 55%), radial-gradient(circle at 10% 15%, rgba(13,148,136,0.18), transparent 45%), linear-gradient(165deg, #050f0d 0%, #0a2320 45%, #0d332e 100%)",
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

const heroActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const diagnoseLinkStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.28)",
  background: "rgba(255,255,255,0.08)",
  color: "#ecfeff",
  borderRadius: 999,
  padding: "10px 18px",
  fontSize: 13.5,
  fontWeight: 700,
  textDecoration: "none",
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

const statsRowStyle: CSSProperties = {
  marginTop: 28,
  display: "flex",
  gap: 16,
  flexWrap: "wrap",
};

const statCardStyle: CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  background: "rgba(255,255,255,0.18)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 20,
  padding: "18px 26px",
  backdropFilter: "blur(10px)",
};

const heroStatCardStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 16,
  background: "linear-gradient(135deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.14) 100%)",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 24,
  padding: "20px 30px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 20px 50px rgba(0,0,0,0.14)",
};

const heroStatIconStyle: CSSProperties = {
  fontSize: 14,
  color: "#4ade80",
  filter: "drop-shadow(0 0 8px rgba(74,222,128,0.9))",
};

const heroStatValueStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 40,
  fontWeight: 900,
  color: "#ffffff",
  lineHeight: 1,
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

const billingPanelStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 20,
  border: "1px solid #e2ede9",
  padding: "22px 24px",
  boxShadow: "0 12px 30px rgba(15, 118, 110, 0.06)",
  marginBottom: 20,
};

const billingHeaderRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 20,
  flexWrap: "wrap",
};

const billingTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#0f172a",
};

const billingSubStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: "#64748b",
  maxWidth: 340,
};

const billingSnapshotStyle: CSSProperties = {
  display: "flex",
  gap: 28,
};

const billingBalanceValueStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 24,
  fontWeight: 800,
  color: "#0f172a",
};

const billingCategoryListStyle: CSSProperties = {
  marginTop: 18,
  paddingTop: 16,
  borderTop: "1px solid #eef2f1",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const billingCategoryRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 13.5,
};

const billingCategoryLabelStyle: CSSProperties = {
  color: "#475569",
};

const billingCategoryValueStyle: CSSProperties = {
  color: "#0f172a",
  fontWeight: 700,
};

const dailyStripSectionStyle: CSSProperties = {
  marginTop: 18,
  paddingTop: 16,
  borderTop: "1px solid #eef2f1",
};

const dailyStripHeaderRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  flexWrap: "wrap",
  gap: 8,
};

const dailyStripTitleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 800,
  color: "#0f172a",
};

const dailyStripTodayValueStyle: CSSProperties = {
  fontSize: 12.5,
  color: "#0f766e",
  fontWeight: 700,
};

const dailyStripRowStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const dailyStripDayStyle: CSSProperties = {
  flex: "1 1 90px",
  background: "#f4fbf9",
  border: "1px solid #e2ede9",
  borderRadius: 12,
  padding: "10px 12px",
  textAlign: "center",
};

const dailyStripDayLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontWeight: 600,
};

const dailyStripDayValueStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 15,
  fontWeight: 800,
  color: "#0f172a",
};

const dailyStripCarrierValueStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 10.5,
  color: "#94a3b8",
};

const carrierNoteStyle: CSSProperties = {
  marginTop: 14,
  fontSize: 12,
  color: "#94a3b8",
  lineHeight: 1.5,
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
