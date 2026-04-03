"use client";

import type { CSSProperties } from "react";

export default function MaintenancePage() {
  return (
    <main style={pageStyle}>
      <div style={glowOneStyle} />
      <div style={glowTwoStyle} />

      <section style={cardStyle}>
        <div style={badgeStyle}>Scheduled Maintenance</div>

        <h1 style={titleStyle}>We’ll be back shortly.</h1>

        <p style={textStyle}>
          Nexgen SMS is currently undergoing maintenance to improve platform
          performance, reliability, and overall experience.
        </p>

        <div style={statsGridStyle}>
          <div style={statCardStyle}>
            <div style={statLabelStyle}>Status</div>
            <div style={statValueStyle}>System Upgrade</div>
          </div>

          <div style={statCardStyle}>
            <div style={statLabelStyle}>Platform</div>
            <div style={statValueStyle}>Nexgen SMS</div>
          </div>

          <div style={statCardStyle}>
            <div style={statLabelStyle}>Availability</div>
            <div style={statValueStyle}>Returning Soon</div>
          </div>
        </div>

        <div style={footerNoteStyle}>Thank you for your patience.</div>
      </section>
    </main>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  position: "relative",
  overflow: "hidden",
  display: "grid",
  placeItems: "center",
  padding: 24,
  background:
    "linear-gradient(180deg, #031312 0%, #071f1d 45%, #0a1716 100%)",
  color: "#ffffff",
};

const glowOneStyle: CSSProperties = {
  position: "absolute",
  width: 520,
  height: 520,
  borderRadius: "50%",
  background: "rgba(20,184,166,0.20)",
  filter: "blur(90px)",
  top: -120,
  left: -120,
};

const glowTwoStyle: CSSProperties = {
  position: "absolute",
  width: 460,
  height: 460,
  borderRadius: "50%",
  background: "rgba(45,212,191,0.14)",
  filter: "blur(90px)",
  bottom: -140,
  right: -100,
};

const cardStyle: CSSProperties = {
  position: "relative",
  zIndex: 2,
  width: "100%",
  maxWidth: 920,
  borderRadius: 32,
  padding: "42px 34px",
  background:
    "linear-gradient(135deg, rgba(15,118,110,0.88) 0%, rgba(13,148,136,0.80) 50%, rgba(20,184,166,0.72) 100%)",
  border: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "0 30px 90px rgba(0,0,0,0.32)",
  backdropFilter: "blur(14px)",
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 999,
  padding: "8px 14px",
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.16)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.4,
};

const titleStyle: CSSProperties = {
  margin: "18px 0 0 0",
  fontSize: 54,
  lineHeight: 1.02,
  fontWeight: 900,
};

const textStyle: CSSProperties = {
  margin: "18px 0 0 0",
  maxWidth: 700,
  fontSize: 17,
  lineHeight: 1.8,
  color: "rgba(236,254,255,0.88)",
};

const statsGridStyle: CSSProperties = {
  marginTop: 28,
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 14,
};

const statCardStyle: CSSProperties = {
  borderRadius: 22,
  padding: 18,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.14)",
};

const statLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(236,254,255,0.72)",
  fontWeight: 700,
};

const statValueStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 20,
  fontWeight: 900,
  color: "#ffffff",
  lineHeight: 1.3,
};

const footerNoteStyle: CSSProperties = {
  marginTop: 28,
  fontSize: 14,
  color: "rgba(236,254,255,0.80)",
  fontWeight: 700,
};