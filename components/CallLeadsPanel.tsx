"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import CallButton from "./CallButton";

// Interested customers picked up on calls. A lead stays here until the first
// text is sent to it; sending that text opens the conversation in Replies and
// the lead leaves this list.

type CallLead = {
  id: string;
  name: string;
  company: string;
  phone: string;
  city: string;
  state: string;
  interestedAt: number;
};

export default function CallLeadsPanel() {
  const [leads, setLeads] = useState<CallLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) return;
    setLoading(true);
    try {
      const snap = await getDocs(
        query(
          collection(db, "leads"),
          where("ownerUid", "==", user.uid),
          where("interested", "==", true)
        )
      );
      const items: CallLead[] = snap.docs
        .filter((d) => d.get("contacted") !== true)
        .map((d) => ({
          id: d.id,
          name: String(d.get("name") || ""),
          company: String(d.get("company") || ""),
          phone: String(d.get("phone") || ""),
          city: String(d.get("city") || ""),
          state: String(d.get("state") || ""),
          interestedAt: d.get("interestedAt")?.toMillis?.() || 0,
        }))
        .sort((a, b) => b.interestedAt - a.interestedAt);
      setLeads(items);
    } catch (e) {
      console.error("Failed to load call leads", e);
      setError("Could not load call leads.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener("lead-disposition", handler);
    return () => window.removeEventListener("lead-disposition", handler);
  }, [load]);

  async function sendText(lead: CallLead) {
    const body = draft.trim();
    const user = auth.currentUser;
    if (!body || !user || sending) return;

    setSending(true);
    setError("");
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/send-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ to: lead.phone, phone: lead.phone, body, name: lead.name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || "Message could not be sent.");
      }

      // Every lead row with this number leaves Call Leads.
      const same = await getDocs(
        query(
          collection(db, "leads"),
          where("ownerUid", "==", user.uid),
          where("phone", "==", lead.phone)
        )
      );
      await Promise.all(
        same.docs.map((d) =>
          updateDoc(doc(db, "leads", d.id), { contacted: true, contactedAt: serverTimestamp() })
        )
      );

      setLeads((prev) => prev.filter((l) => l.phone !== lead.phone));
      setOpenId("");
      setDraft("");
      setNotice(
        `Conversation started with ${lead.name || lead.company || lead.phone}. It has moved to Replies - replies from them will show there.`
      );
    } catch (e: any) {
      setError(e?.message || "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Call Leads</h2>
      <p style={{ margin: "4px 0 14px", opacity: 0.7, fontSize: 14 }}>
        Interested customers from your calls. Send the first text and the lead moves to Replies.
      </p>

      {notice ? (
        <div
          style={{
            background: "rgba(34,197,94,0.12)",
            border: "1px solid rgba(34,197,94,0.45)",
            borderRadius: 12,
            padding: "10px 14px",
            marginBottom: 12,
            fontSize: 14,
          }}
        >
          {notice}{" "}
          <Link href="/replies" style={{ fontWeight: 800, color: "#16a34a" }}>
            Open Replies
          </Link>
        </div>
      ) : null}
      {error ? <div style={{ color: "#dc2626", fontSize: 14, marginBottom: 10 }}>{error}</div> : null}

      {loading ? (
        <div style={{ opacity: 0.7 }}>Loading call leads...</div>
      ) : leads.length === 0 ? (
        <div style={{ opacity: 0.7 }}>
          No call leads yet. Press ★ on a lead (or Interested during a call) to add one.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {leads.map((lead) => (
            <div
              key={lead.id}
              style={{
                border: "1px solid rgba(0,0,0,0.1)",
                borderRadius: 14,
                padding: 14,
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 800 }}>
                    <span style={{ color: "#f59e0b" }}>★</span> {lead.name || lead.company || "-"}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>
                    {lead.name && lead.company ? `${lead.company} · ` : ""}
                    {lead.phone}
                    {lead.city ? ` · ${lead.city}${lead.state ? `, ${lead.state}` : ""}` : ""}
                  </div>
                </div>
                <CallButton phone={lead.phone} size={30} />
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(openId === lead.id ? "" : lead.id);
                    setDraft("");
                    setNotice("");
                  }}
                  style={{
                    border: "none",
                    borderRadius: 10,
                    padding: "9px 16px",
                    fontWeight: 700,
                    cursor: "pointer",
                    background: "linear-gradient(135deg,#22c55e,#16a34a)",
                    color: "#fff",
                  }}
                >
                  Text
                </button>
              </div>

              {openId === lead.id ? (
                <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write your first message..."
                    rows={3}
                    style={{
                      flex: 1,
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.15)",
                      padding: 10,
                      fontSize: 14,
                      fontFamily: "inherit",
                    }}
                  />
                  <button
                    type="button"
                    disabled={sending || !draft.trim()}
                    onClick={() => sendText(lead)}
                    style={{
                      border: "none",
                      borderRadius: 10,
                      padding: "10px 18px",
                      fontWeight: 700,
                      cursor: sending || !draft.trim() ? "not-allowed" : "pointer",
                      opacity: sending || !draft.trim() ? 0.6 : 1,
                      background: "#0f3d3a",
                      color: "#fff",
                    }}
                  >
                    {sending ? "Sending..." : "Send"}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
