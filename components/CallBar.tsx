"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  subscribeCall,
  hangUp,
  toggleMute,
  dismissCallError,
  type CallState,
} from "../lib/voiceClient";
import { blockNumber, markInterested } from "../lib/callDisposition";

// Floating call panel, mounted once in the root layout. Shows while a call is
// connecting, ringing, live, ended or errored. During the call (and for a short
// while after it) the rep can mark the number as an interested customer
// (it then appears in Replies, ready to text) or block it.

function formatTime(total: number) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Mark = "interested" | "blocked" | "saving" | "error";

export default function CallBar() {
  const [call, setCall] = useState<CallState | null>(null);
  const [lastTo, setLastTo] = useState("");
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribeCall(setCall), []);

  const active = !!call && call.status !== "idle";

  // Remember the number so it can still be marked right after the call ends.
  useEffect(() => {
    if (call && call.status !== "idle" && call.to) {
      setLastTo(call.to);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    } else if (call && call.status === "idle" && lastTo) {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setLastTo(""), 30000);
    }
  }, [call, lastTo]);

  async function act(kind: "interested" | "blocked", to: string) {
    if (!to) return;
    if (kind === "blocked" && !window.confirm(`Block ${to}? They won't be called or texted again.`)) {
      return;
    }
    setMarks((m) => ({ ...m, [to]: "saving" }));
    try {
      if (kind === "interested") await markInterested(to);
      else await blockNumber(to);
      setMarks((m) => ({ ...m, [to]: kind }));
    } catch (e) {
      console.error("Call disposition failed", e);
      setMarks((m) => ({ ...m, [to]: "error" }));
    }
  }

  function Actions({ to }: { to: string }) {
    const mark = marks[to];
    if (mark === "interested" || mark === "blocked") {
      return (
        <div style={doneStyle}>
          {mark === "interested"
            ? "Marked interested - open it in Replies to text"
            : "Number blocked"}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={mark === "saving"}
          onClick={() => act("interested", to)}
          style={interestedButtonStyle}
        >
          ★ Interested
        </button>
        <button
          type="button"
          disabled={mark === "saving"}
          onClick={() => act("blocked", to)}
          style={blockButtonStyle}
        >
          Block number
        </button>
        {mark === "error" ? <span style={errStyle}>Could not save - try again</span> : null}
      </div>
    );
  }

  // Compact card after the call panel has gone.
  if (!active) {
    if (!lastTo) return null;
    return (
      <div style={{ ...barStyle, flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={labelStyle}>Last call</div>
            <div style={numberStyle}>{lastTo}</div>
          </div>
          <button type="button" onClick={() => setLastTo("")} style={muteButtonStyle}>
            ✕
          </button>
        </div>
        <Actions to={lastTo} />
      </div>
    );
  }

  const live = call!.status === "in-call";
  const label =
    call!.status === "connecting"
      ? "Connecting..."
      : call!.status === "ringing"
      ? "Ringing..."
      : live
      ? formatTime(call!.seconds)
      : call!.status === "ended"
      ? "Call ended"
      : "Call failed";

  return (
    <div style={{ ...barStyle, flexDirection: "column", alignItems: "stretch" }} role="status">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={numberStyle}>{call!.to}</div>
          <div style={labelStyle}>{call!.status === "error" ? call!.error : label}</div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {live ? (
            <button type="button" onClick={toggleMute} style={muteButtonStyle}>
              {call!.muted ? "Unmute" : "Mute"}
            </button>
          ) : null}
          {call!.status === "error" || call!.status === "ended" ? (
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

      {call!.to && call!.status !== "error" ? <Actions to={call!.to} /> : null}
    </div>
  );
}

const barStyle: CSSProperties = {
  position: "fixed",
  right: 20,
  bottom: 20,
  zIndex: 10000,
  display: "flex",
  gap: 12,
  minWidth: 320,
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

const interestedButtonStyle: CSSProperties = {
  ...muteButtonStyle,
  border: "none",
  background: "linear-gradient(135deg,#22c55e,#16a34a)",
};

const blockButtonStyle: CSSProperties = {
  ...muteButtonStyle,
  border: "1px solid rgba(248,113,113,0.6)",
  background: "rgba(220,38,38,0.2)",
};

const doneStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#86efac",
};

const errStyle: CSSProperties = {
  fontSize: 13,
  color: "#fca5a5",
  alignSelf: "center",
};
