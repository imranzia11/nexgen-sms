"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../lib/firebase";

// Sidebar entry for the Billing page. Renders nothing unless the signed-in
// account has a per-SMS rate configured (checked via /api/billing?check=1),
// so accounts that aren't billed this way never see it.
export default function BillingNavCard() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!cancelled) setEnabled(false);
        return;
      }

      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/billing?check=1", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setEnabled(res.ok && data?.enabled === true);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (!enabled) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <Link href="/billing" style={cardStyle}>
        <div style={iconStyle}>$</div>
        <div>
          <div style={titleStyle}>Billing</div>
          <div style={textStyle}>SMS usage and charges</div>
        </div>
      </Link>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  textDecoration: "none",
};

const iconStyle: CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.9)",
  color: "#0f766e",
  fontSize: 20,
  fontWeight: 900,
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.2,
};

const textStyle: CSSProperties = {
  color: "rgba(255,255,255,0.85)",
  fontSize: 13,
  lineHeight: 1.4,
};
