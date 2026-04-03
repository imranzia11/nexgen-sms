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

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function normalizeValue(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isAdmin(role?: string) {
  const normalized = normalizeValue(role);
  return normalized === "admin" || normalized === "superadmin" || normalized === "super_admin";
}

function conversationMatchesUser(data: Record<string, any>, profile: AppUser) {
  const allowedNumbers = new Set(
    [
      profile.assignedTwilioNumber,
      profile.twilioNumber,
      profile.phoneNumber,
    ]
      .map(normalizePhone)
      .filter(Boolean)
  );

  const allowedServiceSids = new Set(
    [profile.messagingServiceSid].map(normalizeValue).filter(Boolean)
  );

  const docNumbers = [
    data.twilioNumber,
    data.assignedTwilioNumber,
    data.from,
    data.receiver,
    data.accountPhone,
    data.systemNumber,
    data.messagingServiceNumber,
    data.messagingNumber,
    data.phoneNumber,
  ]
    .map(normalizePhone)
    .filter(Boolean);

  const docServiceSids = [
    data.messagingServiceSid,
    data.serviceSid,
    data.messagingSid,
  ]
    .map(normalizeValue)
    .filter(Boolean);

  const numberMatch = docNumbers.some((value) => allowedNumbers.has(value));
  const serviceMatch = docServiceSids.some((value) => allowedServiceSids.has(value));

  return {
    matched: numberMatch || serviceMatch,
    debug: {
      allowedNumbers: Array.from(allowedNumbers),
      allowedServiceSids: Array.from(allowedServiceSids),
      docNumbers,
      docServiceSids,
    },
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
  const [totalConversations, setTotalConversations] = useState(0);

  async function loadConversations(profileArg?: AppUser) {
    try {
      setLoading(true);

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setItems([]);
        setBlockedPhones([]);
        setTotalConversations(0);
        return;
      }

      const conversationsQuery = query(
        collection(db, "conversations"),
        orderBy("lastMessageAt", "desc")
      );

      const blacklistQuery = query(collection(db, "blacklisted_numbers"));

      const [conversationSnap, blacklistSnap] = await Promise.all([
        getDocs(conversationsQuery),
        getDocs(blacklistQuery),
      ]);

      setTotalConversations(conversationSnap.docs.length);

      const blocked = blacklistSnap.docs
        .map((d) => {
          const data = d.data();
          const status = String(data.status || "").toLowerCase();
          if (status !== "blocked") return "";
          return String(data.phone || "").trim();
        })
        .filter(Boolean);

      const blockedSet = new Set(blocked.map((phone) => String(phone).trim()));
      setBlockedPhones(blocked);

      const rows: ConversationItem[] = conversationSnap.docs
        .map((d) => {
          const data = d.data() as Record<string, any>;

          if (!isAdmin(currentProfile.role)) {
            const result = conversationMatchesUser(data, currentProfile);

            console.log("Conversation debug", {
              id: d.id,
              matched: result.matched,
              phone: data.phone,
              twilioNumber: data.twilioNumber,
              assignedTwilioNumber: data.assignedTwilioNumber,
              from: data.from,
              receiver: data.receiver,
              accountPhone: data.accountPhone,
              systemNumber: data.systemNumber,
              messagingServiceNumber: data.messagingServiceNumber,
              messagingServiceSid: data.messagingServiceSid,
              serviceSid: data.serviceSid,
              messagingSid: data.messagingSid,
              ...result.debug,
            });

            if (!result.matched) return null;
          }

          const customerPhone = String(
            data.phone ||
              data.customerPhone ||
              data.leadPhone ||
              data.to ||
              data.contactPhone ||
              "-"
          ).trim();

          return {
            id: d.id,
            phone: customerPhone,
            lastMessage: String(data.lastMessage || ""),
            unreadCount: Number(data.unreadCount || 0),
            lastMessageAtLabel: formatFirestoreDateNY(data.lastMessageAt),
          };
        })
        .filter((item): item is ConversationItem => Boolean(item))
        .filter((item) => !blockedSet.has(String(item.phone || "").trim()));

      setItems(rows);
    } catch (error) {
      console.error("Failed to load conversations", error);
      setItems([]);
      setBlockedPhones([]);
      setTotalConversations(0);
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
      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <section style={panelStyle}>
            <div style={emptyStateStyle}>
              <div style={emptyTitleStyle}>Checking account access...</div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={pageWrapStyle}>
        <div style={heroStyle}>
          <div style={heroInnerStyle}>
            <div>
              <div style={heroBadgeStyle}>Incoming SMS Center</div>
              <h1 style={heroTitleStyle}>Replies</h1>
              <p style={heroTextStyle}>
                Debug mode enabled. Check browser console for conversation matching details.
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
              <StatCard label="All Conversations" value={String(totalConversations)} />
              <StatCard label="Matched For User" value={String(items.length)} />
              <StatCard label="Unread Replies" value={String(totalUnread)} />
              <StatCard label="Blocked Hidden" value={String(blockedPhones.length)} />
            </div>
          </div>
        </div>

        <section style={panelStyle}>
          <div style={panelHeaderStyle}>
            <div>
              <h2 style={panelTitleStyle}>Customer Conversations</h2>
              <p style={panelDescStyle}>Open console and copy one unmatched conversation log.</p>
            </div>

            <button onClick={() => loadConversations()} style={refreshButtonStyle}>
              Refresh
            </button>
          </div>

          {loading ? (
            <div style={emptyStateStyle}>
              <div style={emptyTitleStyle}>Loading replies...</div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={emptyStateStyle}>
              <div style={emptyTitleStyle}>No replies yet</div>
              <div style={emptyTextStyle}>
                Open browser console. We now log exactly why each conversation did not match Sunny.
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
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
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
  background: "#f8fafc",
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
  borderRadius: 32,
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
};

const heroInnerStyle: CSSProperties = {
  padding: 28,
  display: "grid",
  gap: 22,
};

const heroBadgeStyle: CSSProperties = {
  display: "inline-flex",
  borderRadius: 999,
  padding: "8px 14px",
  background: "rgba(255,255,255,0.14)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
};

const heroTitleStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "#ffffff",
  fontSize: 40,
  fontWeight: 900,
};

const heroTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  color: "rgba(236,254,255,0.86)",
  fontSize: 16,
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
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  textDecoration: "none",
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 14,
};

const statCardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.18)",
  borderRadius: 20,
  padding: "18px 18px",
};

const statLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.72)",
  fontSize: 13,
};

const statValueStyle: CSSProperties = {
  marginTop: 10,
  color: "#ffffff",
  fontSize: 30,
  fontWeight: 800,
};

const panelStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 28,
  padding: 22,
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
};

const panelDescStyle: CSSProperties = {
  margin: "8px 0 0 0",
  color: "#64748b",
  fontSize: 14,
};

const refreshButtonStyle: CSSProperties = {
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
  background: "#ffffff",
  borderRadius: 22,
  padding: 20,
  display: "block",
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

const emptyStateStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 22,
  padding: "38px 20px",
  background: "#f8fafc",
  display: "grid",
  justifyItems: "center",
  gap: 10,
  textAlign: "center",
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