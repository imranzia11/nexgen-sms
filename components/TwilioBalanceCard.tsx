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

type BalanceState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; amount: number; currency: string };

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

  const isLow = state.status === "ready" && state.amount < LOW_BALANCE_THRESHOLD;

  return (
    <div style={isLow ? cardStyleLow : cardStyle}>
      <div style={topRowStyle}>
        <div style={isLow ? iconStyleLow : iconStyle}>$</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={titleStyle}>Twilio Balance</div>
          <div style={isLow ? valueStyleLow : valueStyle}>
            {state.status === "loading"
              ? "Loading..."
              : state.status === "error"
              ? "Unavailable"
              : formatBalance(state.amount, state.currency)}
          </div>
        </div>
      </div>

      {isLow ? (
        <div style={hintStyleLow}>
          Balance is low - recharge soon to avoid failed sends.
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setRefreshKey((k) => k + 1)}
        style={isLow ? refreshButtonStyleLow : refreshButtonStyle}
      >
        Refresh balance
      </button>
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
  fontSize: 16,
  fontWeight: 900,
  wordBreak: "break-word",
};

const valueStyleLow: CSSProperties = {
  ...valueStyle,
  color: "#fecaca",
};

const hintStyleLow: CSSProperties = {
  color: "#fecaca",
  fontSize: 12.5,
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
  fontSize: 13,
  cursor: "pointer",
};

const refreshButtonStyleLow: CSSProperties = {
  ...refreshButtonStyle,
  border: "1px solid rgba(220,38,38,0.4)",
  background: "rgba(220,38,38,0.1)",
  color: "#fecaca",
};
