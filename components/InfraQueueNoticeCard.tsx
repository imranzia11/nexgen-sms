"use client";

import type { CSSProperties } from "react";

// Static sidebar warning card, visible to every signed-in user. Reuses the
// same red-alert visual language and pulse animation as the low-balance
// state of TwilioBalanceCard (components/TwilioBalanceCard.tsx) for visual
// consistency - dark teal sidebar background, red-tinted glass card,
// light-red text, subtle pulse to draw the eye without being obnoxious.
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
        CI/CD pipelines are at 80% capacity - builds detected and queued.
        Scale Runner Infrastructure to resolve.
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "16px 18px",
  background: "rgba(220,38,38,0.14)",
  border: "1px solid rgba(220,38,38,0.35)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "grid",
  gap: 10,
  animation: "lowBalancePulse 1.8s ease-in-out infinite",
};

const topRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const iconStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#fecaca",
  color: "#7f1d1d",
  fontSize: 18,
  fontWeight: 900,
  flexShrink: 0,
  animation: "lowBalanceIconFlicker 1.8s ease-in-out infinite",
};

const titleStyle: CSSProperties = {
  color: "#fecaca",
  fontSize: 15,
  fontWeight: 900,
  lineHeight: 1.2,
};

const bodyStyle: CSSProperties = {
  color: "#fecaca",
  fontSize: 12.5,
  lineHeight: 1.5,
  fontWeight: 700,
};
