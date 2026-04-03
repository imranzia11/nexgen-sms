"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  getDoc,
  getDocs,
  orderBy,
  query,
  doc,
  where,
  type Query,
  type DocumentData,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { formatFirestoreDateNY } from "../../lib/date";

type ConversationItem = {
  id: string;
  phone: string;
  lastMessage: string;
  unreadCount: number;
  lastMessageAtLabel: string;
};

type AppUser = {
  uid: string;
  role: string;
  isActive: boolean;
  email?: string;
  name?: string;
  assignedTwilioNumber?: string;
  twilioNumber?: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
};

function truncateText(value: string, max = 110) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function normalizeRole(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isAdmin(role?: string) {
  const normalized = normalizeRole(role);
  return (
    normalized === "admin" ||
    normalized === "superadmin" ||
    normalized === "super_admin"
  );
}

function makeConversationItem(
  id: string,
  data: Record<string, any>
): ConversationItem {
  const customerPhone = String(
    data.phone ||
      data.customerPhone ||
      data.leadPhone ||
      data.to ||
      data.contactPhone ||
      "-"
  ).trim();

  return {
    id,
    phone: customerPhone,
    lastMessage: String(data.lastMessage || ""),
    unreadCount: Number(data.unreadCount || 0),
    lastMessageAtLabel: formatFirestoreDateNY(data.lastMessageAt),
  };
}

export default function RepliesPage() {
  const router = useRouter();

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);
  const [search, setSearch] = useState("");
  const [blockedPhones, setBlockedPhones] = useState<string[]>([]);
  const [profile, setProfile] = useState<AppUser | null>(null);

  async function runConversationQuery(q: Query<DocumentData>) {
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      data: d.data() as Record<string, any>,
    }));
  }

  async function loadConversations(profileArg?: AppUser) {
    try {
      setLoading(true);

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setItems([]);
        setBlockedPhones([]);
        return;
      }

      let blocked: string[] = [];

      if (isAdmin(currentProfile.role)) {
        const blacklistSnap = await getDocs(query(collection(db, "blacklisted_numbers")));
        blocked = blacklistSnap.docs
          .map((d) => {
            const data = d.data();
            return String(data.status || "").toLowerCase() === "blocked"
              ? String(data.phone || "").trim()
              : "";
          })
          .filter(Boolean);
      } else {
        const blacklistDocs = new Map<string, Record<string, any>>();
        const blacklistQueries: Query<DocumentData>[] = [];

        if (currentProfile.messagingServiceSid) {
          blacklistQueries.push(
            query(
              collection(db, "blacklisted_numbers"),
              where("messagingServiceSid", "==", currentProfile.messagingServiceSid)
            )
          );
        }

        if (currentProfile.twilioNumber) {
          blacklistQueries.push(
            query(
              collection(db, "blacklisted_numbers"),
              where("twilioNumber", "==", currentProfile.twilioNumber)
            )
          );
          blacklistQueries.push(
            query(
              collection(db, "blacklisted_numbers"),
              where("assignedTwilioNumber", "==", currentProfile.twilioNumber)
            )
          );
        }

        if (currentProfile.assignedTwilioNumber) {
          blacklistQueries.push(
            query(
              collection(db, "blacklisted_numbers"),
              where("assignedTwilioNumber", "==", currentProfile.assignedTwilioNumber)
            )
          );
          blacklistQueries.push(
            query(
              collection(db, "blacklisted_numbers"),
              where("twilioNumber", "==", currentProfile.assignedTwilioNumber)
            )
          );
        }

        for (const q of blacklistQueries) {
          try {
            const snap = await getDocs(q);
            for (const d of snap.docs) {
              blacklistDocs.set(d.id, d.data() as Record<string, any>);
            }
          } catch (error) {
            console.error("Blacklist query failed", error);
          }
        }

        blocked = Array.from(blacklistDocs.values())
          .map((data) => {
            return String(data.status || "").toLowerCase() === "blocked"
              ? String(data.phone || "").trim()
              : "";
          })
          .filter(Boolean);
      }

      const blockedSet = new Set(blocked.map((phone) => String(phone).trim()));
      setBlockedPhones(blocked);

      let docs: Array<{ id: string; data: Record<string, any> }> = [];

      if (isAdmin(currentProfile.role)) {
        const adminQuery = query(
          collection(db, "conversations"),
          orderBy("lastMessageAt", "desc")
        );
        docs = await runConversationQuery(adminQuery);
      } else {
        const collected = new Map<string, { id: string; data: Record<string, any> }>();
        const queriesToTry: Query<DocumentData>[] = [];

        if (currentProfile.messagingServiceSid) {
          queriesToTry.push(
            query(
              collection(db, "conversations"),
              where("messagingServiceSid", "==", currentProfile.messagingServiceSid),
              orderBy("lastMessageAt", "desc")
            )
          );
        }

        if (currentProfile.twilioNumber) {
          queriesToTry.push(
            query(
              collection(db, "conversations"),
              where("twilioNumber", "==", currentProfile.twilioNumber),
              orderBy("lastMessageAt", "desc")
            )
          );

          queriesToTry.push(
            query(
              collection(db, "conversations"),
              where("assignedTwilioNumber", "==", currentProfile.twilioNumber),
              orderBy("lastMessageAt", "desc")
            )
          );
        }

        if (currentProfile.assignedTwilioNumber) {
          queriesToTry.push(
            query(
              collection(db, "conversations"),
              where("assignedTwilioNumber", "==", currentProfile.assignedTwilioNumber),
              orderBy("lastMessageAt", "desc")
            )
          );

          queriesToTry.push(
            query(
              collection(db, "conversations"),
              where("twilioNumber", "==", currentProfile.assignedTwilioNumber),
              orderBy("lastMessageAt", "desc")
            )
          );
        }

        queriesToTry.push(
          query(
            collection(db, "conversations"),
            where("ownerUid", "==", currentProfile.uid),
            orderBy("lastMessageAt", "desc")
          )
        );

        for (const q of queriesToTry) {
          try {
            const rows = await runConversationQuery(q);
            for (const row of rows) {
              collected.set(row.id, row);
            }
          } catch (error) {
            console.error("Conversation query failed", error);
          }
        }

        docs = Array.from(collected.values()).sort((a, b) => {
          const aTime = a.data?.lastMessageAt?.seconds || 0;
          const bTime = b.data?.lastMessageAt?.seconds || 0;
          return bTime - aTime;
        });
      }

      const rows = docs
        .map((row) => makeConversationItem(row.id, row.data))
        .filter((item) => !blockedSet.has(String(item.phone || "").trim()));

      setItems(rows);
    } catch (error) {
      console.error("Failed to load conversations", error);
      setItems([]);
      setBlockedPhones([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        await signOut(auth).catch(() => {});
        router.push("/login");
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));

        if (!userSnap.exists() || userSnap.data().isActive !== true) {
          await signOut(auth).catch(() => {});
          router.push("/login");
          return;
        }

        const userData = userSnap.data() as Record<string, any>;

        const safeProfile: AppUser = {
          uid: user.uid,
          role: String(userData.role || "user"),
          isActive: userData.isActive === true,
          email: String(userData.email || user.email || ""),
          name: String(userData.name || ""),
          assignedTwilioNumber: String(userData.assignedTwilioNumber || ""),
          twilioNumber: String(userData.twilioNumber || ""),
          phoneNumber: String(userData.phoneNumber || ""),
          messagingServiceSid: String(userData.messagingServiceSid || ""),
        };

        console.log("Replies profile debug", safeProfile);

        setProfile(safeProfile);
        setChecking(false);
        await loadConversations(safeProfile);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;

    return items.filter((item) => {
      return (
        item.phone.toLowerCase().includes(term) ||
        item.lastMessage.toLowerCase().includes(term)
      );
    });
  }, [items, search]);

  const totalUnread = items.reduce((sum, item) => sum + (item.unreadCount || 0), 0);

  if (checking) {
    return (
      <>
        <style jsx global>{`
          @keyframes spin {
            0% {
              transform: rotate(0deg);
            }
            100% {
              transform: rotate(360deg);
            }
          }
        `}</style>

        <main style={pageStyle}>
          <div style={pageWrapStyle}>
            <section style={panelStyle}>
              <div style={emptyStateStyle}>
                <div style={loadingSpinnerStyle} />
                <div style={emptyTitleStyle}>Checking account access...</div>
              </div>
            </section>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <style jsx global>{`
        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        input::placeholder {
          color: rgba(236, 254, 255, 0.78);
        }
      `}</style>

      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <div style={heroStyle}>
            <div style={heroOverlayStyle} />

            <div style={heroInnerStyle}>
              <div>
                <div style={heroBadgeStyle}>Incoming SMS Center</div>
                <h1 style={heroTitleStyle}>Replies</h1>
                <p style={heroTextStyle}>
                  {isAdmin(profile?.role)
                    ? "View all active customer SMS conversations. STOP and blacklisted numbers are hidden from this page and kept in the blacklist area."
                    : "View only your assigned SMS conversations. STOP and blacklisted numbers are hidden from this page and kept in the blacklist area."}
                </p>
              </div>

              <div style={heroActionsStyle}>
                <div style={searchWrapStyle}>
                  <span style={{ fontSize: 16, opacity: 0.85 }}>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by phone number or message"
                    style={searchInputStyle}
                  />
                </div>

                <Link href="/dashboard" style={backButtonStyle}>
                  Back to Dashboard
                </Link>
              </div>

              <div style={statsGridStyle}>
                <StatCard label="Total Conversations" value={String(items.length)} />
                <StatCard label="Unread Replies" value={String(totalUnread)} />
                <StatCard label="Visible Results" value={String(filteredItems.length)} />
                <StatCard label="Blocked Hidden" value={String(blockedPhones.length)} />
              </div>
            </div>
          </div>

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Customer Conversations</h2>
                <p style={panelDescStyle}>
                  Open any visible conversation to view the full reply thread.
                </p>
              </div>

              <button onClick={() => loadConversations()} style={refreshButtonStyle}>
                Refresh
              </button>
            </div>

            {loading ? (
              <div style={emptyStateStyle}>
                <div style={loadingSpinnerStyle} />
                <div style={emptyTitleStyle}>Loading replies...</div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={emptyDotStyle} />
                <div style={emptyTitleStyle}>
                  {search.trim() ? "No matching replies found." : "No visible replies yet."}
                </div>
                <div style={emptyTextStyle}>
                  {search.trim()
                    ? "Try a different phone number or keyword."
                    : "No conversations matched this user account yet. Check whether conversation docs contain messagingServiceSid, twilioNumber, assignedTwilioNumber, or ownerUid matching this user."}
                </div>
              </div>
            ) : (
              <div style={conversationGridStyle}>
                {filteredItems.map((item) => (
                  <Link
                    key={item.id}
                    href={`/replies/${encodeURIComponent(item.phone)}`}
                    style={conversationCardStyle}
                  >
                    <div style={conversationTopStyle}>
                      <div>
                        <div style={phoneStyle}>{item.phone}</div>
                        <div style={timeStyleMobile}>{item.lastMessageAtLabel}</div>
                      </div>

                      <div style={conversationRightStyle}>
                        <div style={timeStyle}>{item.lastMessageAtLabel}</div>

                        {item.unreadCount > 0 ? (
                          <div style={unreadBadgeStyle}>{item.unreadCount} unread</div>
                        ) : (
                          <div style={readBadgeStyle}>Seen</div>
                        )}
                      </div>
                    </div>

                    <div style={messagePreviewStyle}>
                      {truncateText(item.lastMessage || "-")}
                    </div>

                    <div style={openRowStyle}>
                      <span style={openTextStyle}>Open conversation</span>
                      <span style={openArrowStyle}>→</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(20,184,166,0.18), transparent 28%), linear-gradient(180deg, #ecfeff 0%, #f8fafc 46%, #f8fafc 100%)",
  color: "#0f172a",
  padding: 24,
};

const pageWrapStyle: CSSProperties = {
  maxWidth: 1220,
  margin: "0 auto",
  display: "grid",
  gap: 20,
};

const heroStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  borderRadius: 32,
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 30px 80px rgba(13, 148, 136, 0.28)",
};

const heroOverlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(circle at top right, rgba(255,255,255,0.18), transparent 24%), radial-gradient(circle at bottom left, rgba(255,255,255,0.08), transparent 28%)",
  pointerEvents: "none",
};

const heroInnerStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  padding: 28,
  display: "grid",
  gap: 22,
};

const heroBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  width: "fit-content",
  borderRadius: 999,
  padding: "8px 14px",
  background: "rgba(255,255,255,0.14)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.3,
};

const heroTitleStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "#ffffff",
  fontSize: 40,
  lineHeight: 1.05,
  fontWeight: 900,
};

const heroTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  maxWidth: 760,
  color: "rgba(236,254,255,0.86)",
  fontSize: 16,
  lineHeight: 1.65,
};

const heroActionsStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
};

const searchWrapStyle: CSSProperties = {
  flex: 1,
  minWidth: 260,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 16px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.16)",
  backdropFilter: "blur(10px)",
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "#ffffff",
  fontSize: 15,
};

const backButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 14,
};

const statCardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.18)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 20,
  padding: "18px 18px",
  backdropFilter: "blur(10px)",
};

const statLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.72)",
  fontSize: 13,
  fontWeight: 600,
};

const statValueStyle: CSSProperties = {
  marginTop: 10,
  color: "#ffffff",
  fontSize: 30,
  fontWeight: 800,
  lineHeight: 1.15,
  wordBreak: "break-word",
};

const panelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
};

const panelHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 14,
  flexWrap: "wrap",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 900,
  color: "#0f172a",
};

const panelDescStyle: CSSProperties = {
  margin: "8px 0 0 0",
  color: "#64748b",
  fontSize: 14,
  lineHeight: 1.5,
};

const refreshButtonStyle: CSSProperties = {
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  cursor: "pointer",
};

const conversationGridStyle: CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
};

const conversationCardStyle: CSSProperties = {
  textDecoration: "none",
  color: "#0f172a",
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15, 23, 42, 0.06)",
  borderRadius: 22,
  padding: 20,
  display: "block",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.05)",
};

const conversationTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const phoneStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: "#0f172a",
  wordBreak: "break-word",
};

const conversationRightStyle: CSSProperties = {
  textAlign: "right",
};

const timeStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 14,
};

const timeStyleMobile: CSSProperties = {
  marginTop: 6,
  color: "#64748b",
  fontSize: 13,
};

const unreadBadgeStyle: CSSProperties = {
  marginTop: 8,
  display: "inline-block",
  background: "#dc2626",
  color: "#fff",
  borderRadius: 999,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 800,
};

const readBadgeStyle: CSSProperties = {
  marginTop: 8,
  display: "inline-block",
  background: "rgba(16, 185, 129, 0.12)",
  color: "#059669",
  border: "1px solid rgba(16, 185, 129, 0.25)",
  borderRadius: 999,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 800,
};

const messagePreviewStyle: CSSProperties = {
  marginTop: 14,
  color: "#475569",
  fontSize: 15,
  lineHeight: 1.65,
};

const openRowStyle: CSSProperties = {
  marginTop: 18,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const openTextStyle: CSSProperties = {
  color: "#0d9488",
  fontWeight: 800,
  fontSize: 14,
};

const openArrowStyle: CSSProperties = {
  color: "#0d9488",
  fontSize: 22,
  fontWeight: 900,
};

const emptyStateStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 22,
  padding: "38px 20px",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  display: "grid",
  justifyItems: "center",
  gap: 10,
  textAlign: "center",
};

const emptyDotStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  background: "#e2e8f0",
};

const emptyTitleStyle: CSSProperties = {
  fontSize: 16,
  color: "#334155",
  fontWeight: 800,
};

const emptyTextStyle: CSSProperties = {
  fontSize: 14,
  color: "#64748b",
  lineHeight: 1.6,
  maxWidth: 460,
};

const loadingSpinnerStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "3px solid rgba(15,118,110,0.18)",
  borderTop: "3px solid #0f766e",
  animation: "spin 1s linear infinite",
};