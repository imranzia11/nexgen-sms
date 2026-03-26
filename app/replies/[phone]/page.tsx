"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../../lib/firebase";

type MessageItem = {
  id: string;
  body: string;
  from: string;
  to: string;
  direction: string;
  status?: string;
  createdAtLabel: string;
};

function formatDate(value: any) {
  try {
    if (!value) return "-";
    if (typeof value?.toDate === "function") {
      return value.toDate().toLocaleString();
    }
    return "-";
  } catch {
    return "-";
  }
}

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

export default function ReplyThreadPage({
  params,
}: {
  params: { phone: string };
}) {
  const rawPhone = decodeURIComponent(params.phone);
  const convoId = useMemo(() => phoneDocId(rawPhone), [rawPhone]);

  const [items, setItems] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");

  async function loadMessages() {
    try {
      setLoading(true);

      const q = query(
        collection(db, "conversations", convoId, "messages"),
        orderBy("createdAt", "asc")
      );

      const snap = await getDocs(q);

      const rows: MessageItem[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          body: data.body || "",
          from: data.from || "",
          to: data.to || "",
          direction: data.direction || "",
          status: data.status || "",
          createdAtLabel: formatDate(data.createdAt),
        };
      });

      setItems(rows);

      await updateDoc(doc(db, "conversations", convoId), {
        unreadCount: 0,
      });
    } catch (error) {
      console.error("Failed to load thread", error);
      setStatus("Failed to load conversation.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMessages();
  }, [convoId]);

  async function handleSendReply() {
    if (!replyText.trim()) {
      setStatus("Write a reply first.");
      return;
    }

    try {
      setSending(true);
      setStatus("Sending reply...");

      const res = await fetch("/api/send-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: rawPhone,
          body: replyText.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus(data.error || "Failed to send reply.");
        return;
      }

      setReplyText("");
      setStatus("Reply sent.");
      await loadMessages();
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Unexpected error while sending reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        padding: 24,
        color: "#0f172a",
      }}
    >
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "grid", gap: 20 }}>
        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: 30, fontWeight: 800 }}>{rawPhone}</h1>
              <p style={{ marginTop: 8, color: "#475569" }}>
                SMS conversation thread
              </p>
            </div>

            <Link
              href="/replies"
              style={{
                background: "#000",
                color: "#fff",
                textDecoration: "none",
                borderRadius: 14,
                padding: "14px 18px",
                fontWeight: 700,
              }}
            >
              Back to Replies
            </Link>
          </div>
        </div>

        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
          }}
        >
          {loading ? (
            <div>Loading conversation...</div>
          ) : items.length === 0 ? (
            <div>No messages yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {items.map((item) => {
                const inbound = item.direction === "inbound";

                return (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      justifyContent: inbound ? "flex-start" : "flex-end",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "75%",
                        background: inbound ? "#e2e8f0" : "#000",
                        color: inbound ? "#0f172a" : "#fff",
                        borderRadius: 18,
                        padding: "14px 16px",
                      }}
                    >
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        {item.body || "-"}
                      </div>
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 12,
                          opacity: 0.8,
                        }}
                      >
                        {item.createdAtLabel}
                        {item.status ? ` • ${item.status}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Send Reply</h2>

          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Write your SMS reply..."
            rows={5}
            style={{
              width: "100%",
              marginTop: 16,
              borderRadius: 14,
              border: "1px solid #cbd5e1",
              padding: "14px 16px",
              background: "#fff",
              color: "#0f172a",
              fontSize: 16,
              resize: "vertical",
            }}
          />

          <div
            style={{
              marginTop: 16,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              onClick={handleSendReply}
              disabled={sending || !replyText.trim()}
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
                cursor: "pointer",
                opacity: sending || !replyText.trim() ? 0.5 : 1,
              }}
            >
              {sending ? "Sending..." : "Send SMS Reply"}
            </button>

            <button
              onClick={() => loadMessages()}
              style={{
                background: "#e2e8f0",
                color: "#0f172a",
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Refresh
            </button>

            {status ? (
              <span style={{ color: "#475569", fontSize: 14 }}>{status}</span>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}