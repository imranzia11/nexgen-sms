"use client";

import { useEffect, useState } from "react";
import { auth } from "../lib/firebase";

type Info = {
  enabled: boolean;
  textNumber: string;
  callNumber: string;
  dialsFrom: string;
  available: { phoneNumber: string; friendlyName: string }[];
};

function pretty(n: string) {
  const d = n.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n || "-";
}

async function call(method: "GET" | "POST", body?: unknown) {
  const user = auth.currentUser;
  if (!user) throw new Error("You are not signed in.");
  const idToken = await user.getIdToken();
  const res = await fetch("/api/voice/call-number", {
    method,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(json?.error || "Request failed.");
  return json;
}

// Sidebar card: which number my calls are placed from, with a picker.
export default function CallNumberCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setInfo((await call("GET")) as Info);
    } catch {
      setInfo(null);
    }
  };

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      if (u) void load();
    });
    return unsub;
  }, []);

  if (!info || !info.enabled) return null;

  const save = async () => {
    try {
      setBusy(true);
      setError("");
      await call("POST", { callNumber: choice });
      await load();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the number.");
    } finally {
      setBusy(false);
    }
  };

  const box: React.CSSProperties = {
    borderRadius: 16,
    padding: 14,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#fff",
    display: "grid",
    gap: 8,
  };
  const btn: React.CSSProperties = {
    border: "none",
    borderRadius: 10,
    padding: "9px 12px",
    fontWeight: 800,
    cursor: "pointer",
    background: "#fff",
    color: "#0f172a",
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={box}>
        <div style={{ fontSize: 13, fontWeight: 800, opacity: 0.8 }}>My Calling Number</div>
        <div style={{ fontSize: 20, fontWeight: 900 }}>{pretty(info.dialsFrom)}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {info.callNumber ? "Custom calling number" : "Same as your text number"}
        </div>

        {open ? (
          <>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              style={{ borderRadius: 10, padding: 9, fontWeight: 700 }}
            >
              <option value="">Same as text number ({pretty(info.textNumber)})</option>
              {info.available.map((n) => (
                <option key={n.phoneNumber} value={n.phoneNumber}>
                  {pretty(n.phoneNumber)}
                </option>
              ))}
            </select>
            {error ? <div style={{ color: "#fecaca", fontSize: 13, fontWeight: 700 }}>{error}</div> : null}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={btn} disabled={busy} onClick={() => void save()}>
                {busy ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                style={{ ...btn, background: "rgba(255,255,255,0.18)", color: "#fff" }}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            style={btn}
            onClick={() => {
              setChoice(info.callNumber);
              setError("");
              setOpen(true);
            }}
          >
            Change calling number
          </button>
        )}
      </div>
    </div>
  );
}
