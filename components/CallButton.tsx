"use client";

import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebase";
import { isVoiceAvailable, startCall, subscribeCall } from "../lib/voiceClient";

// Small phone icon that calls `phone` from the signed-in account's own
// number. Renders nothing unless calling is switched on for the account
// (users/{uid}.voiceEnabled), so every other account's pages look unchanged.
// Placed next to wherever a phone number is shown, alongside texting.

export default function CallButton({
  phone,
  size = 34,
  title = "Call this number",
}: {
  phone: string;
  size?: number;
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

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={title}
      aria-label={title}
      style={{
        ...buttonStyle,
        width: size,
        height: size,
        opacity: busy ? 0.5 : 1,
        cursor: busy ? "not-allowed" : "pointer",
      }}
    >
      <svg
        width={Math.round(size * 0.5)}
        height={Math.round(size * 0.5)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
      </svg>
    </button>
  );
}

const buttonStyle: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  flexShrink: 0,
  borderRadius: "50%",
  border: "1px solid rgba(15,118,110,0.35)",
  background: "rgba(15,118,110,0.12)",
  color: "#0f766e",
  padding: 0,
};
