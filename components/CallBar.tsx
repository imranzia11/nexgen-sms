"use client";

import { useEffect, useState, type CSSProperties } from "react";
import {
  subscribeCall,
  hangUp,
  toggleMute,
  dismissCallError,
  type CallState,
} from "../lib/voiceClient";

// Floating call panel, mounted once in the root layout. Appears only while a
// call is connecting, ringing, live, just ended, or has errored; otherwise it
// renders nothing.

function formatTime(total: number) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function CallBar() {
  const [call, setCall] = useState<CallState | null>(null);

  useEffect(() => subscribeCall(setCall), []);

  if (!call || call.status === "idle") return null;

  const live = call.status === "in-call";
  const label =
    call.status === "connecting"
      ? "Connecting..."
      : call.status === "ringing"
      ? "Ringing..."
      : live
      ? formatTime(call.seconds)
      : call.status === "ended"
      ? "Call ended"
      : "Call failed";

  return (
    <div style={barStyle} role="status">
      <div style={{ minWidth: 0 }}>
        <div style={numberStyle}>{call.to}</div>
        <div style={labelStyle}>{call.status === "error" ? call.error : label}</div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {live ? (
          <button type="button" onClick={toggleMute} style={muteButtonStyle}>
            {call.muted ? "Unmute" : "Mute"}
          </button>
        ) : null}
        {call.status === "error" || call.status === "ended" ? (
          <button type="button" onClick={dismissCallError} style={muteButtonStyle}>
            Close
          </button>
        ) : (
          <button type="button" onClick={hangUp} style={hangUpButtonStyle}>
            Hang up
          </button>
        )}
      </div>
    </div>
  );
}

const barStyle: CSSProperties = {
  position: "fixed",
  right: 20,
  bottom: 20,
  zIndex: 10000,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  minWidth: 300,
  maxWidth: "calc(100vw - 40px)",
  padding: "14px 16px",
  borderRadius: 18,
  background: "#0f3d3a",
  color: "#ffffff",
  boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
};

const numberStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const labelStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 14,
  fontWeight: 600,
  color: "rgba(236,254,255,0.85)",
};

const muteButtonStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 12,
  padding: "8px 14px",
  background: "rgba(255,255,255,0.1)",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
};

const hangUpButtonStyle: CSSProperties = {
  ...muteButtonStyle,
  border: "none",
  background: "#dc2626",
};
