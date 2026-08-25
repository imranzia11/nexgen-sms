"use client";

import type { CSSProperties } from "react";

// Shared full-page "checking access / loading" screen, used by every
// authenticated page that renders this exact branded card (dashboard, logs,
// stats, blacklisted, templates, help, email-marketing, admin pages).
// Previously each page duplicated its own copy of these style objects. The
// spinner is a small "message being sent" animation (a bubble traveling
// from an origin dot to a target dot, leaving a fading trail) instead of a
// generic spinner, to match the SMS-sending nature of the product.
export default function LoadingScreen({
  text = "Checking account access...",
}: {
  text?: string;
}) {
  return (
    <main style={loadingPageStyle}>
      <div style={loadingCardStyle}>
        <div style={sendTrackStyle}>
          <div style={sendDotOriginStyle} />
          <div style={sendTrailStyle} />
          <div style={sendBubbleStyle}>➤</div>
          <div style={sendDotTargetStyle} />
        </div>

        <p style={loadingTextStyle}>{text}</p>

        <div style={dotsRowStyle}>
          <span style={{ ...dotStyle, animationDelay: "0s" }} />
          <span style={{ ...dotStyle, animationDelay: "0.15s" }} />
          <span style={{ ...dotStyle, animationDelay: "0.3s" }} />
        </div>
      </div>
    </main>
  );
}

const loadingPageStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 50%, #14b8a6 100%)",
};

const loadingCardStyle: CSSProperties = {
  borderRadius: 28,
  padding: "28px 36px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
  backdropFilter: "blur(10px)",
};

const sendTrackStyle: CSSProperties = {
  position: "relative",
  width: 140,
  height: 26,
  display: "flex",
  alignItems: "center",
};

const sendDotOriginStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.35)",
  flexShrink: 0,
};

const sendDotTargetStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#ffffff",
  marginLeft: "auto",
  flexShrink: 0,
  boxShadow: "0 0 12px rgba(255,255,255,0.7)",
};

const sendTrailStyle: CSSProperties = {
  position: "absolute",
  left: 10,
  right: 10,
  height: 2,
  background:
    "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%)",
  transformOrigin: "left center",
  animation: "sendTrailFade 1.6s ease-in-out infinite",
};

const sendBubbleStyle: CSSProperties = {
  position: "absolute",
  left: 4,
  width: 24,
  height: 24,
  borderRadius: "50%",
  background: "#ffffff",
  color: "#0d9488",
  display: "grid",
  placeItems: "center",
  fontSize: 11,
  fontWeight: 900,
  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
  animation: "messageBubbleSend 1.6s ease-in-out infinite",
};

const loadingTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  color: "#e6fffb",
  textAlign: "center",
};

const dotsRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
};

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "#ffffff",
  animation: "loadingDotBounce 1.2s ease-in-out infinite",
};
