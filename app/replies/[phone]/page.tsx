"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../../lib/firebase";

type MessageItem = {
  id: string;
  sid?: string;
  from?: string;
  to?: string;
  body?: string;
  direction?: string;
  status?: string;
  read?: boolean;
  createdAtLabel: string;
};

function phoneDocId(phone: string) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function formatFirestoreDate(value: any) {
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

export default function ReplyThreadPage({
  params,
}: {
  params: Promise<{ phone: string }>;
}) {
  const resolved = use(params);
  const routePhone = decodeURIComponent(resolved.phone || "").trim();
  const conversationId = useMemo(() => phoneDocId(routePhone), [routePhone]);

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [threadTitle, setThreadTitle] = useState(routePhone || "Conversation");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [status, setStatus] = useState("");

  async function loadThread() {
    try {
      setLoading(true);
      setStatus("");

      const convoRef = doc(db, "conversations", conversationId);
      const convoSnap = await getDoc(convoRef);

      if (convoSnap.exists()) {
        const data = convoSnap.data();
        setThreadTitle(data.phone || routePhone || "Conversation");

        if ((data.unreadCount || 0) > 0) {
          await updateDoc(convoRef, { unreadCount: 0 });
        }
      } else {
        setThreadTitle(routePhone || "Conversation");
      }

      const q = query(
        collection(db, "conversations", conversationId, "messages"),
        orderBy("createdAt", "asc")
      );

      const snap = await getDocs(q);

      const items: MessageItem[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          sid: data.sid || "",
          from: data.from || "",
          to: data.to || "",
          body: data.body || "",
          direction: data.direction || "",
          status: data.status || "",
          read: !!data.read,
          createdAtLabel: formatFirestoreDate(data.createdAt),
        };
      });

      setMessages(items);
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to load conversation.");
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!conversationId) return;
    void loadThread();
  }, [conversationId]);

  async function handleSendReply() {
    if (!routePhone) {
      setStatus("Phone number is missing.");
      return;
    }

    if (!replyBody.trim()) {
      setStatus("Please write a reply.");
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
          to: routePhone,
          body: replyBody.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus(data.error || "Failed to send reply.");
        return;
      }

      setReplyBody("");
      setStatus("Reply sent.");
      await loadThread();
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to send reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        color: "#0f172a",
        padding: "24px",
      }}
    >
      <div style={{ maxWidth: 1040, margin: "0 auto", display: "grid", gap: 24 }}>
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>
              {threadTitle}
            </h1>
            <p style={{ marginTop: 8, marginBottom: 0, color: "#475569", fontSize: 16 }}>
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
              padding: "14px 22px",
              fontWeight: 700,
            }}
          >
            Back to Replies
          </Link>
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          {loading ? (
            <div style={{ color: "#64748b" }}>Loading messages...</div>
          ) : messages.length === 0 ? (
            <div style={{ color: "#64748b" }}>No messages yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {messages.map((msg) => {
                const inbound = msg.direction === "inbound";

                return (
                  <div
                    key={msg.id}
                    style={{
                      alignSelf: inbound ? "flex-start" : "flex-end",
                      maxWidth: "78%",
                      background: inbound ? "#eef2ff" : "#dcfce7",
                      border: "1px solid " + (inbound ? "#c7d2fe" : "#bbf7d0"),
                      borderRadius: 18,
                      padding: 14,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#475569",
                        marginBottom: 8,
                        textTransform: "capitalize",
                      }}
                    >
                      {msg.direction || "message"}
                    </div>

                    <div style={{ fontSize: 16, color: "#0f172a", whiteSpace: "pre-wrap" }}>
                      {msg.body || "-"}
                    </div>

                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 12,
                        color: "#64748b",
                      }}
                    >
                      {msg.createdAtLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Send Reply</h2>

          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={6}
            placeholder="Write your SMS reply..."
            style={{
              width: "100%",
              marginTop: 20,
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
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={handleSendReply}
              disabled={sending || !replyBody.trim()}
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
                cursor: "pointer",
                opacity: sending || !replyBody.trim() ? 0.6 : 1,
              }}
            >
              {sending ? "Sending..." : "Send SMS Reply"}
            </button>

            <button
              onClick={() => void loadThread()}
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