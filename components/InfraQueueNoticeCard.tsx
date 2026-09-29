"use client";

import type { CSSProperties } from "react";

// Static sidebar warning card, visible to every signed-in user. Deliberately
// louder than the low-balance state of TwilioBalanceCard - solid red fill
// instead of a translucent glass tint, white text, brighter pulse - and
// placed at the very top of the sidebar (right below the "Signed in as"
// card) so it's the first thing anyone sees, rather than buried further
// down the card stack.
export default function InfraQueueNoticeCard() {
  return (
    <div style={cardStyle}>
      <div style={topRowStyle}>
        <div style={iconStyle}>!</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={titleStyle}>Priority Warning</div>
        </div>
      </div>
      <div style={bodyStyle}>
        CI/CD pipelines are at 90% capacity - builds detected and queued.
        Scale Runner Infrastructure to resolve.
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)",
  border: "1px solid rgba(255,255,255,0.25)",
  boxShadow: "0 18px 40px rgba(153,27,27,0.45)",
  display: "grid",
  gap: 10,
  animation: "lowBalancePulse 1.4s ease-in-out infinite",
};

const topRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const iconStyle: CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ffffff",
  color: "#991b1b",
  fontSize: 20,
  fontWeight: 900,
  flexShrink: 0,
  animation: "lowBalanceIconFlicker 1.4s ease-in-out infinite",
};

const titleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 900,
  lineHeight: 1.2,
  letterSpacing: 0.2,
};

const bodyStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 13,
  lineHeight: 1.5,
  fontWeight: 700,
};
