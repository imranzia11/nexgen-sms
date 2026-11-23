"use client";

import { useEffect, useState } from "react";
import { auth } from "../lib/firebase";

type FreeNumber = {
  phoneNumber: string;
  friendlyName: string;
  calls24h: number;
  lastCallAt: string;
};

type Info = {
  enabled: boolean;
  textNumber: string;
  callNumber: string;
  dialsFrom: string;
  available: FreeNumber[];
};

function pretty(n: string) {
  const d = n.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n || "-";
}

function ago(iso: string) {
  if (!iso) return "Not used in 30 days";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} day(s) ago`;
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

// Sidebar card for the voice calling number. "Change number" opens a second
// screen listing every free number with how much it was used for calls in the
// last 24 hours.
export default function CallNumberCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setLoading(true);
      setInfo((await call("GET")) as Info);
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
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

  const btn: React.CSSProperties = {
    border: "none",
    borderRadius: 10,
    padding: "10px 14px",
    fontWeight: 800,
    cursor: "pointer",
    background: "#fff",
    color: "#0f172a",
  };
  const cell: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };

  return (
    <>
      <div
        style={{
          width: "100%",
          borderRadius: 26,
          padding: "18px 18px",
          background: "rgba(255,255,255,0.10)",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
          backdropFilter: "blur(10px)",
          color: "#fff",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              background: "#ccfbf1",
              color: "#115e59",
              fontSize: 22,
              fontWeight: 900,
              flexShrink: 0,
            }}
          >
            ✆
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "#fff", fontSize: 18, fontWeight: 900, lineHeight: 1.1 }}>
              Voice Calling Number
            </div>
            <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900, wordBreak: "break-word" }}>
              {pretty(info.dialsFrom)}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: "rgba(236,254,255,0.7)" }}>
              {info.callNumber ? "Custom calling number" : "Same as your SMS number"}
            </div>
          </div>
        </div>
        <button
          type="button"
          style={{
            width: "100%",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 14,
            padding: "10px 14px",
            background: "rgba(255,255,255,0.08)",
            color: "#ffffff",
            fontWeight: 800,
            fontSize: 15,
            cursor: "pointer",
          }}
          onClick={() => {
            setChoice(info.callNumber);
            setError("");
            setOpen(true);
            void load();
          }}
        >
          Change number
        </button>
      </div>

      {open ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(15,23,42,0.55)",
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => !busy && setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 100%)",
              maxHeight: "88vh",
              overflow: "auto",
              background: "#fff",
              color: "#0f172a",
              borderRadius: 20,
              padding: 22,
              display: "grid",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 900 }}>Choose your voice calling number</div>
              <button
                type="button"
                style={{ ...btn, background: "#e2e8f0" }}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
            <div style={{ color: "#475569", fontSize: 14, fontWeight: 600 }}>
              Calls are placed from the number you pick. Texts always go from your SMS number (
              {pretty(info.textNumber)}). Pick a number that has been used less to avoid it being
              flagged as spam.
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}>
                <thead>
                  <tr style={{ color: "#64748b", fontSize: 13 }}>
                    <th style={cell}></th>
                    <th style={cell}>Number</th>
                    <th style={cell}>Calls in last 24h</th>
                    <th style={cell}>Last used to call</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    onClick={() => setChoice("")}
                    style={{
                      borderTop: "1px solid #e2e8f0",
                      cursor: "pointer",
                      background: choice === "" ? "#ecfdf5" : "transparent",
                    }}
                  >
                    <td style={cell}>
                      <input type="radio" readOnly checked={choice === ""} />
                    </td>
                    <td style={{ ...cell, fontWeight: 800 }}>{pretty(info.textNumber)}</td>
                    <td style={cell} colSpan={2}>
                      Default - same as your SMS number
                    </td>
                  </tr>
                  {info.available.map((n) => (
                    <tr
                      key={n.phoneNumber}
                      onClick={() => setChoice(n.phoneNumber)}
                      style={{
                        borderTop: "1px solid #e2e8f0",
                        cursor: "pointer",
                        background: choice === n.phoneNumber ? "#ecfdf5" : "transparent",
                      }}
                    >
                      <td style={cell}>
                        <input type="radio" readOnly checked={choice === n.phoneNumber} />
                      </td>
                      <td style={{ ...cell, fontWeight: 800 }}>{pretty(n.phoneNumber)}</td>
                      <td style={{ ...cell, fontWeight: 800 }}>{n.calls24h}</td>
                      <td style={cell}>{ago(n.lastCallAt)}</td>
                    </tr>
                  ))}
                  {info.available.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={4} style={{ ...cell, color: "#64748b" }}>
                        No other numbers are available right now.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {error ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                disabled={busy || choice === info.callNumber}
                onClick={() => void save()}
                style={{
                  ...btn,
                  background: "#0f766e",
                  color: "#fff",
                  opacity: busy || choice === info.callNumber ? 0.5 : 1,
                }}
              >
                {busy ? "Saving..." : "Use this number"}
              </button>
              <button
                type="button"
                style={{ ...btn, background: "#e2e8f0" }}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
