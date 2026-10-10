"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebase";

// Sidebar billing card, styled like the Twilio number / balance cards. Shows
// this month's usage charge (SMS sent + received x the account's per-SMS
// rate) from /api/billing. Renders nothing at all unless the signed-in
// account has a rate configured, so accounts not billed this way never see it.

type CardState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; amount: number; total: number; sent: number; received: number };

function money(value: number) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function BillingNavCard() {
  const [state, setState] = useState<CardState>({ status: "hidden" });

  useEffect(() => {
    let cancelled = false;

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!cancelled) setState({ status: "hidden" });
        return;
      }

      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/billing", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => ({}));

        if (cancelled) return;

        if (!res.ok || data?.enabled !== true) {
          setState({ status: "hidden" });
          return;
        }

        setState({
          status: "ready",
          amount: Number(data.amount) || 0,
          total: Number(data.total) || 0,
          sent: Number(data.sent) || 0,
          received: Number(data.received) || 0,
        });
      } catch {
        if (!cancelled) setState({ status: "hidden" });
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (state.status === "hidden") return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={cardStyle}>
        <div style={topRowStyle}>
          <div style={iconStyle}>$</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={titleStyle}>Billing</div>
            <div style={valueStyle}>
              {state.status === "loading" ? "Loading..." : money(state.amount)}
            </div>
          </div>
        </div>

        {state.status === "ready" ? (
          <div style={hintStyle}>
            This month: {state.sent.toLocaleString()} sent +{" "}
            {state.received.toLocaleString()} received ={" "}
            {state.total.toLocaleString()} SMS
          </div>
        ) : null}

        <Link href="/billing" style={buttonStyle}>
          View billing
        </Link>
      </div>
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

const titleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.1,
};

const valueStyle: CSSProperties = {
  marginTop: 6,
  color: "#ffffff",
  fontSize: 22,
  fontWeight: 900,
  wordBreak: "break-word",
};

const hintStyle: CSSProperties = {
  color: "rgba(255,255,255,0.85)",
  fontSize: 14,
  lineHeight: 1.5,
  fontWeight: 700,
};

const buttonStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  textAlign: "center",
  textDecoration: "none",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 14,
  padding: "10px 14px",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 15,
};
