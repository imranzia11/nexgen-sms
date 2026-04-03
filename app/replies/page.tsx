"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  getDoc,
  getDocs,
  query,
  doc,
  where,
  orderBy,
  type Query,
  type DocumentData,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { formatFirestoreDateNY } from "../../lib/date";

type SmsRow = {
  id: string;
  phone: string;
  name?: string;
  body: string;
  createdAtLabel: string;
  sortSeconds: number;
  status: string;
  replied: boolean;
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

function getSortSeconds(value: any) {
  if (!value) return 0;
  if (typeof value.seconds === "number") return value.seconds;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return 0;
}

function phoneKey(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function makeSmsRow(
  id: string,
  data: Record<string, any>,
  repliedPhones: Set<string>
): SmsRow {
  const phone = String(data.to || data.phone || "").trim();
  const normalizedPhone = phoneKey(phone);

  return {
    id,
    phone,
    name: String(data.name || ""),
    body: String(data.body || ""),
    createdAtLabel: formatFirestoreDateNY(data.createdAt),
    sortSeconds: getSortSeconds(data.createdAt),
    status: String(data.status || "sent"),
    replied: repliedPhones.has(normalizedPhone),
  };
}

export default function RepliesPage() {
  const router = useRouter();

  const [items, setItems] = useState<SmsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);
  const [search, setSearch] = useState("");
  const [blockedPhones, setBlockedPhones] = useState<string[]>([]);
  const [profile, setProfile] = useState<AppUser | null>(null);

  async function runQuery(q: Query<DocumentData>) {
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      data: d.data() as Record<string, any>,
    }));
  }

  async function loadItems(profileArg?: AppUser) {
    try {
      setLoading(true);

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setItems([]);
        setBlockedPhones([]);
        return;
      }

      let blocked: string[] = [];
      const repliedPhones = new Set<string>();

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
          .map((data) =>
            String(data.status || "").toLowerCase() === "blocked"
              ? String(data.phone || "").trim()
              : ""
          )
          .filter(Boolean);
      }

      const blockedSet = new Set(blocked.map((phone) => phoneKey(phone)));
      setBlockedPhones(blocked);

      try {
        let replyDocs: Array<{ id: string; data: Record<string, any> }> = [];

        if (isAdmin(currentProfile.role)) {
          replyDocs = await runQuery(query(collection(db, "replies")));
        } else {
          const replyQueries: Query<DocumentData>[] = [
            query(collection(db, "replies"), where("ownerUid", "==", currentProfile.uid)),
          ];

          if (currentProfile.messagingServiceSid) {
            replyQueries.push(
              query(
                collection(db, "replies"),
                where("messagingServiceSid", "==", currentProfile.messagingServiceSid)
              )
            );
          }

          if (currentProfile.twilioNumber) {
            replyQueries.push(
              query(
                collection(db, "replies"),
                where("twilioNumber", "==", currentProfile.twilioNumber)
              )
            );
          }

          const replyMap = new Map<string, { id: string; data: Record<string, any> }>();

          for (const q of replyQueries) {
            try {
              const rows = await runQuery(q);
              for (const row of rows) replyMap.set(row.id, row);
            } catch (error) {
              console.error("Replies query failed", error);
            }
          }

          replyDocs = Array.from(replyMap.values());
        }

        for (const row of replyDocs) {
          const p = phoneKey(row.data.from || row.data.phone || "");
          if (p) repliedPhones.add(p);
        }
      } catch (error) {
        console.error("Failed to collect replied phones", error);
      }

      let messageDocs: Array<{ id: string; data: Record<string, any> }> = [];

      if (isAdmin(currentProfile.role)) {
        messageDocs = await runQuery(
          query(
            collection(db, "messages"),
            where("direction", "==", "outbound"),
            orderBy("createdAt", "desc")
          )
        );
      } else {
        const messageQueries: Query<DocumentData>[] = [
          query(
            collection(db, "messages"),
            where("ownerUid", "==", currentProfile.uid),
            where("direction", "==", "outbound")
          ),
        ];

        if (currentProfile.messagingServiceSid) {
          messageQueries.push(
            query(
              collection(db, "messages"),
              where("messagingServiceSid", "==", currentProfile.messagingServiceSid),
              where("direction", "==", "outbound")
            )
          );
        }

        if (currentProfile.twilioNumber) {
          messageQueries.push(
            query(
              collection(db, "messages"),
              where("twilioNumber", "==", currentProfile.twilioNumber),
              where("direction", "==", "outbound")
            )
          );
        }

        const messageMap = new Map<string, { id: string; data: Record<string, any> }>();

        for (const q of messageQueries) {
          try {
            const rows = await runQuery(q);
            for (const row of rows) messageMap.set(row.id, row);
          } catch (error) {
            console.error("Messages query failed", error);
          }
        }

        messageDocs = Array.from(messageMap.values());
      }

      const rows = messageDocs
        .map((row) => makeSmsRow(row.id, row.data, repliedPhones))
        .filter((item) => {
          const p = phoneKey(item.phone);
          if (!p) return false;
          if (blockedSet.has(p)) return false;
          return true;
        })
        .sort((a, b) => b.sortSeconds - a.sortSeconds);

      setItems(rows);
    } catch (error) {
      console.error("Failed to load sms activity", error);
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

        setProfile(safeProfile);
        setChecking(false);
        await loadItems(safeProfile);
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
        String(item.name || "").toLowerCase().includes(term) ||
        item.body.toLowerCase().includes(term)
      );
    });
  }, [items, search]);

  const repliedCount = items.filter((item) => item.replied).length;
  const awaitingCount = items.filter((item) => !item.replied).length;

  if (checking) {
    return (
      <>
        <style jsx global>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
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
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
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
                <div style={heroBadgeStyle}>SMS Activity</div>
                <h1 style={heroTitleStyle}>All Sent SMS</h1>
                <p style={heroTextStyle}>
                  This page shows every outbound SMS. Each row tells you whether that phone has replied or is still awaiting a reply. STOP and blacklisted numbers are hidden.
                </p>
              </div>

              <div style={heroActionsStyle}>
                <div style={searchWrapStyle}>
                  <span style={{ fontSize: 16, opacity: 0.85 }}>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by phone number, name or message"
                    style={searchInputStyle}
                  />
                </div>

                <Link href="/dashboard" style={backButtonStyle}>
                  Back to Dashboard
                </Link>
              </div>

              <div style={statsGridStyle}>
                <StatCard label="All Sent SMS" value={String(items.length)} />
                <StatCard label="Replied" value={String(repliedCount)} />
                <StatCard label="Awaiting Reply" value={String(awaitingCount)} />
                <StatCard label="Blocked Hidden" value={String(blockedPhones.length)} />
              </div>
            </div>
          </div>

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Outbound SMS Activity</h2>
                <p style={panelDescStyle}>
                  Every row below is one sent SMS, marked as Replied or Awaiting Reply.
                </p>
              </div>

              <button onClick={() => loadItems()} style={refreshButtonStyle}>
                Refresh
              </button>
            </div>

            {loading ? (
              <div style={emptyStateStyle}>
                <div style={loadingSpinnerStyle} />
                <div style={emptyTitleStyle}>Loading SMS activity...</div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={emptyDotStyle} />
                <div style={emptyTitleStyle}>
                  {search.trim()
                    ? "No matching SMS activity found."
                    : "No outbound SMS found."}
                </div>
                <div style={emptyTextStyle}>
                  {search.trim()
                    ? "Try a different phone number, name or keyword."
                    : "No sent SMS matched this account yet."}
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
                        {item.name ? <div style={nameStyle}>{item.name}</div> : null}
                        <div style={timeStyleMobile}>{item.createdAtLabel}</div>
                      </div>

                      <div style={conversationRightStyle}>
                        <div style={timeStyle}>{item.createdAtLabel}</div>
                        <div
                          style={
                            item.replied
                              ? repliedBadgeStyle
                              : awaitingReplyBadgeStyle
                          }
                        >
                          {item.replied ? "Replied" : "Awaiting Reply"}
                        </div>
                      </div>
                    </div>

                    <div style={messagePreviewStyle}>
                      {truncateText(item.body || "-")}
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

const nameStyle: CSSProperties = {
  marginTop: 6,
  color: "#0d9488",
  fontSize: 14,
  fontWeight: 700,
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

const awaitingReplyBadgeStyle: CSSProperties = {
  marginTop: 8,
  display: "inline-block",
  background: "rgba(245, 158, 11, 0.12)",
  color: "#b45309",
  border: "1px solid rgba(245, 158, 11, 0.25)",
  borderRadius: 999,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 800,
};

const repliedBadgeStyle: CSSProperties = {
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