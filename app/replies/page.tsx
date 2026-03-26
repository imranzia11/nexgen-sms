"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "../../lib/firebase";

type ConversationItem = {
  id: string;
  phone: string;
  lastMessage: string;
  unreadCount: number;
  lastMessageAtLabel: string;
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

export default function RepliesPage() {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadConversations() {
    try {
      setLoading(true);

      const q = query(
        collection(db, "conversations"),
        orderBy("lastMessageAt", "desc")
      );

      const snap = await getDocs(q);

      const rows: ConversationItem[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          phone: data.phone || d.id,
          lastMessage: data.lastMessage || "",
          unreadCount: data.unreadCount || 0,
          lastMessageAtLabel: formatDate(data.lastMessageAt),
        };
      });

      setItems(rows);
    } catch (error) {
      console.error("Failed to load conversations", error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadConversations();
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        padding: 24,
        color: "#0f172a",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "grid", gap: 20 }}>
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
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800 }}>Replies</h1>
              <p style={{ marginTop: 8, color: "#475569" }}>
                All customer SMS replies.
              </p>
            </div>

            <Link
              href="/dashboard"
              style={{
                background: "#000",
                color: "#fff",
                textDecoration: "none",
                borderRadius: 14,
                padding: "14px 18px",
                fontWeight: 700,
              }}
            >
              Back to Dashboard
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
            <div>Loading replies...</div>
          ) : items.length === 0 ? (
            <div>No replies yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {items.map((item) => (
                <Link
                  key={item.id}
                  href={`/replies/${encodeURIComponent(item.phone)}`}
                  style={{
                    textDecoration: "none",
                    color: "#0f172a",
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: 18,
                    padding: 18,
                    display: "block",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 800 }}>{item.phone}</div>
                      <div style={{ marginTop: 6, color: "#475569" }}>
                        {item.lastMessage || "-"}
                      </div>
                    </div>

                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: "#475569", fontSize: 14 }}>
                        {item.lastMessageAtLabel}
                      </div>

                      {item.unreadCount > 0 ? (
                        <div
                          style={{
                            marginTop: 8,
                            display: "inline-block",
                            background: "#dc2626",
                            color: "#fff",
                            borderRadius: 999,
                            padding: "6px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {item.unreadCount} unread
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}