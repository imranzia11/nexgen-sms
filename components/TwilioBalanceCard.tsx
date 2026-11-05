"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebase";

// Sidebar card showing the shared Twilio account's available balance -
// added after an account-wide low-balance outage silently failed every
// send with a Twilio 20003 auth error (see tools/resend-failed-auth-messages.ts).
// There is exactly one Twilio account behind every rep on this platform, so
// this is intentionally visible to every signed-in user, not just
// superadmin - anyone noticing a low number here can flag it before it
// turns into another outage. Below LOW_BALANCE_THRESHOLD it switches to a
// red warning treatment instead of the normal teal-tinted card.
const LOW_BALANCE_THRESHOLD = 70;

// Accounts on a prepaid plan see their own internal balance (managed by the
// superadmin) instead of the shared Twilio figure, with a lower warning
// threshold.
const INTERNAL_LOW_THRESHOLD = 50;

type BalanceState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      amount: number;
      currency: string;
      internal?: boolean;
      unset?: boolean;
      locked?: boolean;
      max?: number;
    };

function formatBalance(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase() || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export default function TwilioBalanceCard() {
  const [state, setState] = useState<BalanceState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!cancelled) setState({ status: "error" });
        return;
      }

      try {
        setState({ status: "loading" });
        const idToken = await user.getIdToken();

        // Prepaid accounts: internal balance, never the Twilio one.
        const billingRes = await fetch("/api/billing?check=1", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const billingJson = await billingRes.json().catch(() => ({}));
        if (billingRes.ok && billingJson?.prepaid) {
          if (!cancelled) {
            setState({
              status: "ready",
              amount: Number(billingJson.prepaid.balance) || 0,
              currency: "usd",
              internal: true,
              locked: billingJson.creditLocked === true,
              max: Number(billingJson.selfCreditMax) || 500,
            });
          }
          return;
        }
        // Billing-enabled but no balance set yet: still never show Twilio's.
        if (billingRes.ok && billingJson?.enabled === true) {
          if (!cancelled) {
            setState({
              status: "ready",
              amount: 0,
              currency: "usd",
              internal: true,
              unset: true,
              locked: billingJson.creditLocked === true,
              max: Number(billingJson.selfCreditMax) || 500,
            });
          }
          return;
        }

        const res = await fetch("/api/twilio-balance", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data?.ok === false) {
          throw new Error(data?.error || "Failed to load balance");
        }

        if (!cancelled) {
          setState({
            status: "ready",
            amount: Number(data.amount) || 0,
            currency: String(data.currency || "usd"),
          });
        }
      } catch (error) {
        console.error("Failed to load Twilio balance", error);
        if (!cancelled) setState({ status: "error" });
      }
    });

    return () => {
      cancelled = true;
      unsubAuth();
    };
  }, [refreshKey]);

  const internal = state.status === "ready" && state.internal === true;
  const [showForm, setShowForm] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  // One-time balance setup from the sidebar. Runs next to a short "updating"
  // animation; once set it is locked server-side (see /api/billing/credit).
  const handleSetup = async () => {
    const amount = Number(amountInput.trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError("Enter an amount greater than 0.");
      return;
    }

    try {
      setBusy(true);
      setFormError("");
      const user = auth.currentUser;
      if (!user) return;
      const idToken = await user.getIdToken();

      const [res] = await Promise.all([
        fetch("/api/billing/credit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ amount }),
        }),
        new Promise((resolve) => setTimeout(resolve, 2600)),
      ]);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || "Could not update the balance.");
      }

      setShowForm(false);
      setAmountInput("");
      setRefreshKey((k) => k + 1);
    } catch (error: any) {
      setFormError(error?.message || "Could not update the balance.");
    } finally {
      setBusy(false);
    }
  };

  const unset = state.status === "ready" && state.unset === true;
  const locked = state.status === "ready" && state.locked === true;
  const maxAmount = state.status === "ready" ? state.max || 500 : 500;
  const isLow =
    state.status === "ready" &&
    !unset &&
    state.amount < (internal ? INTERNAL_LOW_THRESHOLD : LOW_BALANCE_THRESHOLD);

  return (
    <div style={isLow ? cardStyleLow : cardStyle}>
      <div style={topRowStyle}>
        <div style={isLow ? iconStyleLow : iconStyle}>$</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={titleStyle}>{internal ? "Account Balance" : "Twilio Balance"}</div>
          <div style={isLow ? valueStyleLow : valueStyle}>
            {state.status === "loading"
              ? "Loading..."
              : state.status === "error"
              ? "Unavailable"
              : unset
              ? "Not set - open Billing"
              : formatBalance(state.amount, state.currency)}
          </div>
        </div>
      </div>

      {isLow ? (
        <div style={hintStyleLow}>
          {internal
            ? "Balance is low - contact your account manager."
            : "Balance is low - recharge soon to avoid failed sends."}
        </div>
      ) : null}

      {internal ? (
        locked ? (
          <div style={lockedNoteStyle}>To add more balance, seek admin permission.</div>
        ) : busy ? (
          <div style={lockedNoteStyle}>Updating your balance...</div>
        ) : showForm ? (
          <div style={{ display: "grid", gap: 8 }}>
            <input
              type="number"
              min={1}
              max={maxAmount}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder={`Amount (max ${maxAmount})`}
              style={amountInputStyle}
            />
            {formError ? <div style={formErrorStyle}>{formError}</div> : null}
            <button type="button" onClick={handleSetup} style={refreshButtonStyle}>
              Add credit
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            style={isLow ? refreshButtonStyleLow : refreshButtonStyle}
          >
            Setup balance
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          style={isLow ? refreshButtonStyleLow : refreshButtonStyle}
        >
          Refresh balance
        </button>
      )}
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "grid",
  gap: 14,
};

const cardStyleLow: CSSProperties = {
  ...cardStyle,
  background: "rgba(220,38,38,0.14)",
  border: "1px solid rgba(220,38,38,0.35)",
  animation: "lowBalancePulse 1.8s ease-in-out infinite",
};

const topRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const iconStyle: CSSProperties = {
  width: 54,
  height: 54,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 22,
  fontWeight: 900,
  flexShrink: 0,
};

const iconStyleLow: CSSProperties = {
  ...iconStyle,
  background: "#fecaca",
  color: "#7f1d1d",
  animation: "lowBalanceIconFlicker 1.8s ease-in-out infinite",
};

const titleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.1,
};

const valueStyle: CSSProperties = {
  marginTop: 6,
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  wordBreak: "break-word",
};

const valueStyleLow: CSSProperties = {
  ...valueStyle,
  color: "#fecaca",
};

const hintStyleLow: CSSProperties = {
  color: "#fecaca",
  fontSize: 14,
  lineHeight: 1.5,
  fontWeight: 700,
};

const refreshButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 14,
  padding: "10px 14px",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 15,
  cursor: "pointer",
};

const amountInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  padding: "10px 12px",
  fontSize: 16,
  fontWeight: 700,
};

const lockedNoteStyle: CSSProperties = {
  color: "rgba(236,254,255,0.85)",
  fontSize: 14,
  lineHeight: 1.5,
  fontWeight: 700,
};

const formErrorStyle: CSSProperties = {
  color: "#fecaca",
  fontSize: 14,
  fontWeight: 700,
};

const refreshButtonStyleLow: CSSProperties = {
  ...refreshButtonStyle,
  border: "1px solid rgba(220,38,38,0.4)",
  background: "rgba(220,38,38,0.1)",
  color: "#fecaca",
};
