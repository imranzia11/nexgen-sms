"use client";

import type { CSSProperties } from "react";

// Static sidebar notice card, visible to every signed-in user. Amber/yellow
// treatment - a lower-severity, informational notice rather than the red,
// pulsing "stop and act" treatment this card used at higher capacity
// numbers. No pulse animation here on purpose: this state is explicitly
// "can be ignored for now," so a calm static card matches that tone better
// than an attention-grabbing one. Placed at the very top of the sidebar
// (right below the "Signed in as" card) so it's still the first thing
// anyone sees, just without the urgency.
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
        CI/CD pipelines are at 50% capacity - can be ignored until usage
        reaches 90%. Scale Runner Infrastructure to resolve if that
        threshold is reached.
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "linear-gradient(135deg, #f59e0b 0%, #b45309 100%)",
  border: "1px solid rgba(255,255,255,0.25)",
  boxShadow: "0 18px 40px rgba(180,83,9,0.35)",
  display: "grid",
  gap: 10,
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
  color: "#b45309",
  fontSize: 20,
  fontWeight: 900,
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.2,
  letterSpacing: 0.2,
};

const bodyStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 15,
  lineHeight: 1.5,
  fontWeight: 700,
};
