"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type Query,
  type DocumentData,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { formatFirestoreDateNY } from "../../lib/date";

type CampaignLogItem = {
  id: string;
  name: string;
  fileName: string;
  status: string;
  totalRecipients: number;
  successCount: number;
  failedCount: number;
  createdByName: string;
  createdAtLabel: string;
};

type MessageLogItem = {
  id: string;
  to: string;
  name: string;
  body: string;
  status: string;
  twilioSid: string;
  error: string;
  sourceFileName: string;
  createdAtLabel: string;
};

type AppUser = {
  uid: string;
  role: string;
  isActive: boolean;
  email?: string;
  name?: string;
};

function truncateText(value: string, max = 120) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function truncateMiddle(value: string, start = 10, end = 8) {
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
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

function statusChipTone(status?: string) {
  const value = String(status || "").toLowerCase();

  if (
    value.includes("completed") ||
    value.includes("sent") ||
    value.includes("success")
  ) {
    return {
      bg: "rgba(16, 185, 129, 0.12)",
      text: "#059669",
      border: "rgba(16, 185, 129, 0.25)",
    };
  }

  if (value.includes("failed") || value.includes("error")) {
    return {
      bg: "rgba(239, 68, 68, 0.12)",
      text: "#dc2626",
      border: "rgba(239, 68, 68, 0.25)",
    };
  }

  if (value.includes("queued") || value.includes("processing")) {
    return {
      bg: "rgba(245, 158, 11, 0.12)",
      text: "#b45309",
      border: "rgba(245, 158, 11, 0.25)",
    };
  }

  return {
    bg: "rgba(59, 130, 246, 0.12)",
    text: "#2563eb",
    border: "rgba(59, 130, 246, 0.25)",
  };
}

export default function LogsPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("User");
  const [profile, setProfile] = useState<AppUser | null>(null);

  const [campaigns, setCampaigns] = useState<CampaignLogItem[]>([]);
  const [messages, setMessages] = useState<MessageLogItem[]>([]);
  const [search, setSearch] = useState("");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));

        if (!snap.exists() || snap.data().isActive !== true) {
          await signOut(auth).catch(() => {});
          router.push("/login");
          return;
        }

        const userData = snap.data() as Record<string, any>;

        const safeProfile: AppUser = {
          uid: user.uid,
          role: String(userData.role || "user"),
          isActive: userData.isActive === true,
          email: String(userData.email || user.email || ""),
          name: String(userData.name || ""),
        };

        const safeName =
          String(userData.name || "").trim() ||
          String(user.displayName || "").trim() ||
          String(user.email || "").split("@")[0] ||
          "User";

        setUserName(safeName);
        setProfile(safeProfile);
        setChecking(false);
        await loadLogs(safeProfile);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  const loadLogs = async (profileArg?: AppUser) => {
    try {
      setLoading(true);
      setErrorText("");

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setCampaigns([]);
        setMessages([]);
        return;
      }

      let campaignsQuery: Query<DocumentData>;
      let messagesQuery: Query<DocumentData>;

      if (isAdmin(currentProfile.role)) {
        campaignsQuery = query(
          collection(db, "campaigns"),
          orderBy("createdAt", "desc"),
          limit(50)
        );

        messagesQuery = query(
          collection(db, "messages"),
          orderBy("createdAt", "desc"),
          limit(100)
        );
      } else {
        campaignsQuery = query(
          collection(db, "campaigns"),
          where("createdBy", "==", currentProfile.uid),
          orderBy("createdAt", "desc"),
          limit(50)
        );

        messagesQuery = query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          orderBy("createdAt", "desc"),
          limit(100)
        );
      }

      const [campaignSnap, messageSnap] = await Promise.all([
        getDocs(campaignsQuery),
        getDocs(messagesQuery),
      ]);

      const campaignRows: CampaignLogItem[] = campaignSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name || "-",
          fileName: data.fileName || "-",
          status: data.status || "-",
          totalRecipients: Number(data.totalRecipients || 0),
          successCount: Number(data.successCount || 0),
          failedCount: Number(data.failedCount || 0),
          createdByName: data.createdByName || "-",
          createdAtLabel: formatFirestoreDateNY(data.createdAt),
        };
      });

      const messageRows: MessageLogItem[] = messageSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          to: data.to || "-",
          name: data.name || "",
          body: data.body || "",
          status: data.status || "-",
          twilioSid: data.twilioSid || data.sid || "",
          error: data.error || "",
          sourceFileName: data.sourceFileName || "-",
          createdAtLabel: formatFirestoreDateNY(data.createdAt),
        };
      });

      setCampaigns(campaignRows);
      setMessages(messageRows);
    } catch (error: any) {
      console.error("Failed to load logs", error);
      setErrorText(error?.message || "Failed to load logs.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  const filteredCampaigns = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return campaigns;

    return campaigns.filter((item) => {
      return (
        item.name.toLowerCase().includes(term) ||
        item.fileName.toLowerCase().includes(term) ||
        item.status.toLowerCase().includes(term) ||
        item.createdByName.toLowerCase().includes(term) ||
        item.id.toLowerCase().includes(term)
      );
    });
  }, [campaigns, search]);

  const filteredMessages = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return messages;

    return messages.filter((item) => {
      return (
        item.to.toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.status.toLowerCase().includes(term) ||
        item.sourceFileName.toLowerCase().includes(term) ||
        item.body.toLowerCase().includes(term) ||
        item.id.toLowerCase().includes(term) ||
        item.twilioSid.toLowerCase().includes(term)
      );
    });
  }, [messages, search]);

  const totalCampaigns = campaigns.length;
  const totalMessages = messages.length;
  const totalSent = messages.filter((m) =>
    String(m.status).toLowerCase().includes("sent")
  ).length;
  const totalFailed = messages.filter((m) =>
    String(m.status).toLowerCase().includes("failed")
  ).length;

  if (checking || loading) {
    return (
      <main style={loadingPageStyle}>
        <div style={loadingCardStyle}>
          <div style={spinnerStyle} />
          <div style={{ color: "#ffffff", fontWeight: 800, fontSize: 18 }}>
            Loading logs...
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={pageShellStyle}>
        <aside style={sidebarStyle}>
          <div>
            <div style={brandWrapStyle}>
              <div style={brandIconStyle}>N</div>
              <div>
                <div style={brandTitleStyle}>Nexgen SMS</div>
                <div style={brandSubStyle}>User Portal</div>
              </div>
            </div>

            <div style={adminMiniCardStyle}>
              <div style={avatarStyle}>
                {userName?.slice(0, 1)?.toUpperCase() || "U"}
              </div>
              <div>
                <div style={sidebarSmallLabelStyle}>Signed in as</div>
                <div style={sidebarAdminNameStyle}>{userName}</div>
              </div>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/dashboard" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>⌂</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Dashboard</div>
                  <div style={sidebarRepliesTextStyle}>Back to SMS control center</div>
                </div>
              </Link>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/replies" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>↩</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Replies</div>
                  <div style={sidebarRepliesTextStyle}>Open incoming messages</div>
                </div>
              </Link>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/blacklisted" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>⛔</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Blacklisted</div>
                  <div style={sidebarRepliesTextStyle}>View blocked numbers</div>
                </div>
              </Link>
            </div>
          </div>

          <div style={sidebarBottomLogoutWrapStyle}>
            <div style={{ display: "grid", gap: 12 }}>
              <Link href="/logs" style={sidebarSecondaryLinkButtonStyle}>
                Logs
              </Link>

              <button onClick={handleLogout} style={sidebarLogoutButtonStyle}>
                Logout
              </button>
            </div>
          </div>
        </aside>

        <section style={contentStyle}>
          <div style={heroCardStyle}>
            <div style={heroOverlayStyle} />
            <div style={heroInnerStyle}>
              <div>
                <div style={heroBadgeStyle}>Activity Center</div>
                <h1 style={heroTitleStyle}>Logs</h1>
                <p style={heroTextStyle}>
                  Review recent campaigns and outbound message activity in New York time.
                </p>
              </div>

              <div style={heroTopControlsStyle}>
                <div style={searchBarStyle}>
                  <span style={{ fontSize: 16, opacity: 0.8 }}>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search campaign, file, phone, message, sid, status"
                    style={searchInputStyle}
                  />
                </div>

                <button onClick={() => loadLogs()} style={heroPrimaryButtonStyle}>
                  Refresh Logs
                </button>
              </div>

              <div style={statsGridStyle}>
                <StatCard label="Campaign Logs" value={String(totalCampaigns)} />
                <StatCard label="Message Logs" value={String(totalMessages)} />
                <StatCard label="Sent" value={String(totalSent)} />
                <StatCard label="Failed" value={String(totalFailed)} />
              </div>
            </div>
          </div>

          {errorText ? <div style={errorBoxStyle}>{errorText}</div> : null}

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Campaign Logs</h2>
                <p style={panelDescStyle}>
                  Most recent campaign documents from Firestore.
                </p>
              </div>
            </div>

            {filteredCampaigns.length === 0 ? (
              <EmptyState text="No campaign logs found." />
            ) : (
              <div style={cardGridStyle}>
                {filteredCampaigns.map((item) => {
                  const tone = statusChipTone(item.status);

                  return (
                    <div key={item.id} style={logCardStyle}>
                      <div style={logCardTopStyle}>
                        <div style={{ minWidth: 0 }}>
                          <div style={logTitleStyle}>{item.name}</div>
                          <div style={logSubStyle}>File: {item.fileName}</div>
                        </div>

                        <span
                          style={{
                            background: tone.bg,
                            color: tone.text,
                            border: `1px solid ${tone.border}`,
                            borderRadius: 999,
                            padding: "8px 12px",
                            fontSize: 12,
                            fontWeight: 800,
                            textTransform: "capitalize",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.status}
                        </span>
                      </div>

                      <div style={infoGridStyle}>
                        <MiniInfo label="Campaign ID" value={truncateMiddle(item.id)} />
                        <MiniInfo label="Recipients" value={String(item.totalRecipients)} />
                        <MiniInfo label="Success" value={String(item.successCount)} />
                        <MiniInfo label="Failed" value={String(item.failedCount)} />
                        <MiniInfo label="Created By" value={item.createdByName} />
                        <MiniInfo label="Created At" value={item.createdAtLabel} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Message Logs</h2>
                <p style={panelDescStyle}>
                  Most recent outbound message records from Firestore.
                </p>
              </div>
            </div>

            {filteredMessages.length === 0 ? (
              <EmptyState text="No message logs found." />
            ) : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>To</th>
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>Message</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>SID</th>
                      <th style={thStyle}>Source File</th>
                      <th style={thStyle}>Created</th>
                      <th style={thStyle}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMessages.map((item) => {
                      const tone = statusChipTone(item.status);

                      return (
                        <tr key={item.id}>
                          <td style={tdStyle}>{item.to || "-"}</td>
                          <td style={tdStyle}>{item.name || "-"}</td>
                          <td style={tdStyle}>{truncateText(item.body || "-", 90)}</td>
                          <td style={tdStyle}>
                            <span
                              style={{
                                background: tone.bg,
                                color: tone.text,
                                border: `1px solid ${tone.border}`,
                                borderRadius: 999,
                                padding: "6px 10px",
                                fontSize: 12,
                                fontWeight: 800,
                                textTransform: "capitalize",
                                display: "inline-block",
                              }}
                            >
                              {item.status}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            {truncateMiddle(item.twilioSid || "-", 8, 6)}
                          </td>
                          <td style={tdStyle}>{item.sourceFileName || "-"}</td>
                          <td style={tdStyle}>{item.createdAtLabel}</td>
                          <td style={tdStyle}>{truncateText(item.error || "-", 60)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
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

function MiniInfo({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniInfoCardStyle}>
      <div style={miniInfoLabelStyle}>{label}</div>
      <div style={miniInfoValueStyle}>{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={emptyStateStyle}>
      <div style={emptyStateIconStyle}>•</div>
      <div style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}>{text}</div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(20,184,166,0.18), transparent 28%), linear-gradient(180deg, #ecfeff 0%, #f8fafc 46%, #f8fafc 100%)",
  color: "#0f172a",
};

const pageShellStyle: CSSProperties = {
  width: "100%",
  minHeight: "100vh",
  display: "grid",
  gridTemplateColumns: "290px 1fr",
};

const sidebarStyle: CSSProperties = {
  background: "linear-gradient(180deg, #0f766e 0%, #0b5f59 100%)",
  padding: 24,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  gap: 24,
  position: "sticky",
  top: 0,
  minHeight: "100vh",
  boxShadow: "inset -1px 0 0 rgba(255,255,255,0.08)",
};

const brandWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const brandIconStyle: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 18,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.14)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 22,
  boxShadow: "0 10px 25px rgba(0,0,0,0.18)",
};

const brandTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 20,
  lineHeight: 1.1,
};

const brandSubStyle: CSSProperties = {
  marginTop: 4,
  color: "rgba(236, 254, 255, 0.7)",
  fontSize: 13,
};

const adminMiniCardStyle: CSSProperties = {
  marginTop: 24,
  borderRadius: 22,
  padding: 16,
  background: "rgba(255,255,255,0.09)",
  border: "1px solid rgba(255,255,255,0.12)",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const avatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontWeight: 800,
  fontSize: 18,
  flexShrink: 0,
};

const sidebarSmallLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.68)",
  fontSize: 12,
};

const sidebarAdminNameStyle: CSSProperties = {
  marginTop: 4,
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 800,
};

const sidebarRepliesWrapStyle: CSSProperties = {
  marginTop: 18,
};

const sidebarRepliesCardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  textDecoration: "none",
};

const sidebarBottomLogoutWrapStyle: CSSProperties = {
  display: "grid",
};

const sidebarSecondaryLinkButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 16,
  padding: "14px 16px",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
  textDecoration: "none",
  textAlign: "center",
};

const sidebarRepliesIconStyle: CSSProperties = {
  width: 54,
  height: 54,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 24,
  fontWeight: 900,
  flexShrink: 0,
};

const sidebarRepliesTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.1,
};

const sidebarRepliesTextStyle: CSSProperties = {
  marginTop: 6,
  color: "rgba(236, 254, 255, 0.78)",
  fontSize: 13,
  lineHeight: 1.4,
};

const sidebarLogoutButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 16,
  padding: "14px 16px",
  background: "transparent",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
};

const contentStyle: CSSProperties = {
  padding: 24,
  display: "grid",
  gap: 20,
};

const heroCardStyle: CSSProperties = {
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
  fontSize: 38,
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

const heroTopControlsStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
};

const searchBarStyle: CSSProperties = {
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

const heroPrimaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
  cursor: "pointer",
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

const errorBoxStyle: CSSProperties = {
  borderRadius: 18,
  padding: "14px 16px",
  background: "#7f1d1d",
  color: "#ffffff",
  fontSize: 14,
  lineHeight: 1.5,
};

const cardGridStyle: CSSProperties = {
  marginTop: 18,
  display: "grid",
  gap: 16,
};

const logCardStyle: CSSProperties = {
  borderRadius: 24,
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15,23,42,0.06)",
  padding: 18,
  boxShadow: "0 10px 24px rgba(15,23,42,0.05)",
};

const logCardTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
  flexWrap: "wrap",
};

const logTitleStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 900,
  color: "#0f172a",
  wordBreak: "break-word",
};

const logSubStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: "#64748b",
};

const infoGridStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 12,
};

const miniInfoCardStyle: CSSProperties = {
  borderRadius: 16,
  background: "#f8fafc",
  padding: 12,
  border: "1px solid #eef2f7",
};

const miniInfoLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  fontWeight: 700,
};

const miniInfoValueStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  color: "#0f172a",
  fontWeight: 800,
  wordBreak: "break-word",
};

const tableWrapStyle: CSSProperties = {
  marginTop: 18,
  overflowX: "auto",
  borderRadius: 20,
  border: "1px solid #eef2f7",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#ffffff",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "14px 16px",
  background: "#f8fafc",
  color: "#475569",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 13,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "14px 16px",
  color: "#0f172a",
  borderBottom: "1px solid #f1f5f9",
  fontSize: 14,
  verticalAlign: "middle",
};

const emptyStateStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 22,
  padding: "34px 18px",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  display: "grid",
  justifyItems: "center",
  gap: 10,
  textAlign: "center",
};

const emptyStateIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#e2e8f0",
  color: "#475569",
  fontWeight: 900,
};

const loadingPageStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 50%, #14b8a6 100%)",
};

const loadingCardStyle: CSSProperties = {
  borderRadius: 28,
  padding: "28px 32px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  backdropFilter: "blur(10px)",
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.25)",
  borderTop: "3px solid #ffffff",
  animation: "spin 1s linear infinite",
};