"use client";

import { useEffect, useState, type CSSProperties } from "react";

// Shown once per sign-in, mounted globally from app/layout.tsx so it
// appears regardless of which page a login redirects to (dashboard, the
// Replies PWA shortcut, etc). app/login/page.tsx sets the sessionStorage
// flag below right before redirecting a signed-in (non-superadmin) user;
// this component checks for it on mount, shows the modal if present, and
// clears the flag immediately so it doesn't reappear on every subsequent
// page load within the same session - only on the next actual login.
const SHOW_FLAG_KEY = "nexgen_show_infra_notice";

export default function InfraExhaustedLoginModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(SHOW_FLAG_KEY) === "1") {
        setVisible(true);
        window.sessionStorage.removeItem(SHOW_FLAG_KEY);
      }
    } catch {
      // sessionStorage unavailable (private browsing, etc) - just skip the
      // notice rather than crash.
    }
  }, []);

  if (!visible) return null;

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <div style={iconStyle}>!</div>
        <div style={titleStyle}>CI/CD Infrastructure Exhausted</div>
        <div style={messageStyle}>
          Please note: builds are queued while Runner Infrastructure is
          scaled. Some actions may be temporarily limited until this
          resolves.
        </div>
        <button
          style={okButtonStyle}
          onClick={() => setVisible(false)}
          autoFocus
        >
          OK
        </button>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
  padding: 20,
};

const cardStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 20,
  padding: "28px 26px",
  maxWidth: 380,
  width: "100%",
  boxShadow: "0 30px 80px rgba(0,0,0,0.28)",
  textAlign: "center",
};

const iconStyle: CSSProperties = {
  width: 48,
  height: 48,
  margin: "0 auto",
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#fecaca",
  color: "#991b1b",
  fontSize: 22,
  fontWeight: 900,
};

const titleStyle: CSSProperties = {
  marginTop: 16,
  fontSize: 17,
  fontWeight: 900,
  color: "#991b1b",
};

const messageStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 14.5,
  lineHeight: 1.55,
  color: "#0f172a",
};

const okButtonStyle: CSSProperties = {
  marginTop: 22,
  width: "100%",
  padding: "12px 0",
  borderRadius: 12,
  border: "none",
  background: "#dc2626",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
};
