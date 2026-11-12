"use client";

import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebase";
import { isVoiceAvailable, startCall, subscribeCall } from "../lib/voiceClient";

// Call button for a phone number, placed alongside texting. Renders nothing
// unless calling is switched on for the account (users/{uid}.voiceEnabled),
// so every other account's pages look unchanged.
//
// Variants:
//  - "prominent": a green "Call" pill with a pulsing ring and a ringing
//    handset - the main call action in a conversation header.
//  - "round" (default): a solid green round button with the same pulse, sized
//    for table rows and the phone top bar.

const CSS = `
@keyframes callPulseRing {
  0%   { transform: scale(1);    opacity: 0.55; }
  70%  { transform: scale(1.65); opacity: 0; }
  100% { transform: scale(1.65); opacity: 0; }
}
@keyframes callHandsetRing {
  0%, 60%, 100% { transform: rotate(0deg); }
  66% { transform: rotate(-16deg); }
  72% { transform: rotate(14deg); }
  78% { transform: rotate(-12deg); }
  84% { transform: rotate(10deg); }
  90% { transform: rotate(-6deg); }
}
.call-btn { position: relative; transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }
.call-btn:not(:disabled):hover { transform: translateY(-2px) scale(1.04); filter: brightness(1.08); }
.call-btn:not(:disabled):active { transform: scale(0.97); }
.call-btn .call-ring {
  position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: rgba(34,197,94,0.55);
  animation: callPulseRing 2.2s ease-out infinite;
}
.call-btn:disabled .call-ring { animation: none; opacity: 0; }
.call-btn .call-icon { display: inline-flex; animation: callHandsetRing 3.2s ease-in-out infinite; }
.call-btn:disabled .call-icon { animation: none; }
@media (prefers-reduced-motion: reduce) {
  .call-btn .call-ring, .call-btn .call-icon { animation: none; }
}
`;

function Handset({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export default function CallButton({
  phone,
  size = 36,
  variant = "round",
  title = "Call this number",
}: {
  phone: string;
  size?: number;
  variant?: "round" | "prominent";
  title?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) {
        if (!cancelled) setAvailable(false);
        return;
      }
      void isVoiceAvailable().then((ok) => {
        if (!cancelled) setAvailable(ok);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(
    () =>
      subscribeCall((s) =>
        setBusy(s.status === "connecting" || s.status === "ringing" || s.status === "in-call")
      ),
    []
  );

  if (!available || !phone) return null;

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    // Often sits inside a clickable row/link - don't trigger that.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    void startCall(phone);
  };

  const prominent = variant === "prominent";

  return (
    <>
      <style>{CSS}</style>
      <button
        type="button"
        className="call-btn"
        onClick={handleClick}
        disabled={busy}
        title={title}
        aria-label={title}
        style={
          prominent
            ? { ...prominentStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "not-allowed" : "pointer" }
            : {
                ...roundStyle,
                width: size,
                height: size,
                opacity: busy ? 0.6 : 1,
                cursor: busy ? "not-allowed" : "pointer",
              }
        }
      >
        <span className="call-ring" />
        <span className="call-icon" style={{ position: "relative" }}>
          <Handset size={prominent ? 22 : Math.round(size * 0.5)} />
        </span>
        {prominent ? <span style={{ position: "relative" }}>{busy ? "In call" : "Call"}</span> : null}
      </button>
    </>
  );
}

const greenGradient = "linear-gradient(135deg, #22c55e 0%, #15803d 100%)";

const prominentStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  border: "none",
  borderRadius: 999,
  padding: "14px 26px",
  background: greenGradient,
  color: "#ffffff",
  fontSize: 17,
  fontWeight: 900,
  letterSpacing: 0.3,
  boxShadow: "0 10px 26px rgba(21,128,61,0.45)",
};

const roundStyle: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  flexShrink: 0,
  borderRadius: "50%",
  border: "none",
  background: greenGradient,
  color: "#ffffff",
  padding: 0,
  boxShadow: "0 6px 16px rgba(21,128,61,0.4)",
};
