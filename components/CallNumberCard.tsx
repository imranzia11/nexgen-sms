"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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

      {open
        ? createPortal(
            <NumberPicker
              info={info}
              choice={choice}
              setChoice={setChoice}
              busy={busy}
              loading={loading}
              error={error}
              onSave={() => void save()}
              onClose={() => setOpen(false)}
            />,
            document.body
          )
        : null}
    </>
  );
}

function usage(n: number) {
  if (n === 0) return { label: "Fresh", bg: "#dcfce7", fg: "#15803d" };
  if (n < 50) return { label: "Light use", bg: "#fef9c3", fg: "#a16207" };
  return { label: "Heavy use", bg: "#fee2e2", fg: "#b91c1c" };
}

function NumberPicker(props: {
  info: Info;
  choice: string;
  setChoice: (v: string) => void;
  busy: boolean;
  loading: boolean;
  error: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const { info, choice, setChoice, busy, loading, error, onSave, onClose } = props;
  const unchanged = choice === info.callNumber;

  const rows: { key: string; value: string; title: string; sub: string; calls?: number; last?: string; badge?: ReturnType<typeof usage> }[] = [
    {
      key: "default",
      value: "",
      title: pretty(info.textNumber),
      sub: "Default - same as your SMS number",
    },
    ...info.available.map((n) => ({
      key: n.phoneNumber,
      value: n.phoneNumber,
      title: pretty(n.phoneNumber),
      sub: ago(n.lastCallAt),
      calls: n.calls24h,
      badge: usage(n.calls24h),
    })),
  ];

  return (
    <div
      onClick={() => !busy && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "rgba(15,23,42,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          color: "#0f172a",
          borderRadius: 24,
          boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "22px 24px 14px", borderBottom: "1px solid #e2e8f0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div style={{ fontSize: 22, fontWeight: 900 }}>Voice calling number</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                border: "none",
                background: "#f1f5f9",
                borderRadius: "50%",
                width: 34,
                height: 34,
                fontSize: 18,
                fontWeight: 900,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
          <div style={{ marginTop: 6, color: "#64748b", fontSize: 14, lineHeight: 1.5 }}>
            Calls go out from the number you pick. Texts always use your SMS number,{" "}
            <strong>{pretty(info.textNumber)}</strong>. A number with fewer calls today is less likely to be flagged as spam.
          </div>
        </div>

        <div style={{ padding: 16, display: "grid", gap: 10, overflowY: "auto" }}>
          {rows.map((r) => {
            const selected = choice === r.value;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => setChoice(r.value)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  textAlign: "left",
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 16,
                  cursor: "pointer",
                  background: selected ? "#ecfdf5" : "#fff",
                  border: selected ? "2px solid #0f766e" : "2px solid #e2e8f0",
                  color: "#0f172a",
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    flexShrink: 0,
                    border: selected ? "6px solid #0f766e" : "2px solid #cbd5e1",
                    background: "#fff",
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 18, fontWeight: 900 }}>{r.title}</span>
                  <span style={{ display: "block", marginTop: 2, fontSize: 13, color: "#64748b" }}>
                    {r.calls === undefined ? r.sub : `Last used: ${r.sub}`}
                  </span>
                </span>
                {r.calls !== undefined && r.badge ? (
                  <span style={{ textAlign: "right", flexShrink: 0 }}>
                    <span style={{ display: "block", fontSize: 20, fontWeight: 900 }}>{r.calls}</span>
                    <span style={{ display: "block", fontSize: 11, color: "#64748b" }}>calls / 24h</span>
                    <span
                      style={{
                        display: "inline-block",
                        marginTop: 4,
                        borderRadius: 999,
                        padding: "2px 9px",
                        fontSize: 11,
                        fontWeight: 800,
                        background: r.badge.bg,
                        color: r.badge.fg,
                      }}
                    >
                      {r.badge.label}
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
          {info.available.length === 0 && !loading ? (
            <div style={{ color: "#64748b", fontSize: 14, padding: "4px 6px" }}>
              No other numbers are available right now.
            </div>
          ) : null}
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {error ? (
            <span style={{ color: "#b91c1c", fontWeight: 700, fontSize: 13, flex: 1 }}>{error}</span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              borderRadius: 12,
              padding: "11px 18px",
              fontWeight: 800,
              background: "#e2e8f0",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || unchanged}
            onClick={onSave}
            style={{
              border: "none",
              borderRadius: 12,
              padding: "11px 20px",
              fontWeight: 800,
              background: "#0f766e",
              color: "#fff",
              cursor: busy || unchanged ? "not-allowed" : "pointer",
              opacity: busy || unchanged ? 0.5 : 1,
            }}
          >
            {busy ? "Saving..." : "Use this number"}
          </button>
        </div>
      </div>
    </div>
  );
}
