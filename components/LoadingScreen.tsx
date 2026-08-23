"use client";

import type { CSSProperties } from "react";

// Shared full-page "checking access / loading" screen, used by every
// authenticated page that renders this exact branded card (dashboard, logs,
// stats, blacklisted, templates). Previously each page duplicated its own
// copy of these three style objects (and, on some pages, an unused
// reference to a "spin" animation that was never defined locally — see
// app/globals.css for the shared keyframe that now fixes that).
export default function LoadingScreen({
  text = "Checking account access...",
}: {
  text?: string;
}) {
  return (
    <main style={loadingPageStyle}>
      <div style={loadingCardStyle}>
        <div style={spinnerStyle} />
        <p style={loadingTextStyle}>{text}</p>
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
  padding: "28px 32px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  backdropFilter: "blur(10px)",
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.25)",
  borderTop: "3px solid #ffffff",
  animation: "spin 1s linear infinite",
};

const loadingTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  color: "#e6fffb",
};
