"use client";

import type { CSSProperties } from "react";

// Shared full-page "checking access / loading" screen, used by every
// authenticated page that renders this exact branded card (dashboard, logs,
// stats, blacklisted, templates, help, email-marketing, admin pages).
// Previously each page duplicated its own copy of these style objects.
// Background matches the dark near-black + teal glow theme now used across
// every sidebar and the login page. The spinner was replaced with a small
// "message being sent" animation (a bubble traveling from an origin dot to
// a target dot, leaving a fading trail) to match the SMS-sending nature of
// the product instead of a generic spinner.
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
  background:
    "radial-gradient(circle at 85% 75%, rgba(20,184,166,0.38), transparent 55%), radial-gradient(circle at 10% 15%, rgba(13,148,136,0.18), transparent 45%), linear-gradient(165deg, #050f0d 0%, #0a2320 45%, #0d332e 100%)",
};

const loadingCardStyle: CSSProperties = {
  borderRadius: 28,
  padding: "32px 40px",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.14)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 18,
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow: "0 25px 60px rgba(0,0,0,0.35)",
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
  background: "#5eead4",
  marginLeft: "auto",
  flexShrink: 0,
  boxShadow: "0 0 12px rgba(94,234,212,0.7)",
};

const sendTrailStyle: CSSProperties = {
  position: "absolute",
  left: 10,
  right: 10,
  height: 2,
  background:
    "linear-gradient(90deg, transparent 0%, rgba(94,234,212,0.55) 50%, transparent 100%)",
  transformOrigin: "left center",
  animation: "sendTrailFade 1.6s ease-in-out infinite",
};

const sendBubbleStyle: CSSProperties = {
  position: "absolute",
  left: 4,
  width: 24,
  height: 24,
  borderRadius: "50%",
  background: "#14b8a6",
  color: "#052e2b",
  display: "grid",
  placeItems: "center",
  fontSize: 11,
  fontWeight: 900,
  boxShadow: "0 4px 16px rgba(20,184,166,0.5)",
  animation: "messageBubbleSend 1.6s ease-in-out infinite",
};

const loadingTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
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
  background: "#5eead4",
  animation: "loadingDotBounce 1.2s ease-in-out infinite",
};
