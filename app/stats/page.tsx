"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
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
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { currentNYMonthString, getNYMonthRangeUtc, nyDateKey } from "../../lib/date";
import LoadingScreen from "../../components/LoadingScreen";
import RepliesNavBadge from "../../components/RepliesNavBadge";

// One bar per calendar day of the selected month, not a single running
// total - a month can only ever be picked (native <input type="month">,
// capped at the current month), never an arbitrary date, so there's no
// separate "which day" lookup mode to reconcile with this view.
//
// Every account only ever sees its own count here — same owner-scoped
// query pattern as /logs, so it can never fail under the security rules
// and can never show one account's numbers to another.
//
// "Sent" counts BOTH regular sends/replies (root `messages` collection) and
// follow-ups (their own `followUps` collection, status "sent") - see the
// comment on accumulateDayCounts below for why those live in two different
// places and both have to be queried to get a true day total.

type AppUser = {
  uid: string;
  isActive: boolean;
  email?: string;
  name?: string;
};

function normalizeStatus(status?: string) {
  return String(status || "").trim().toLowerCase();
}

function isSuccessfulStatus(status?: string) {
  const value = normalizeStatus(status);
  return value === "delivered" || value === "sent";
}

function formatMonthLabel(monthStr: string) {
  const [y, m] = monthStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, 1));
  return dt.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function StatsPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("User");
  const [profile, setProfile] = useState<AppUser | null>(null);

  const [selectedMonth, setSelectedMonth] = useState(currentNYMonthString());
  const [dayCounts, setDayCounts] = useState<Record<number, number>>({});
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
        await loadStats(safeProfile, selectedMonth);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (!profile) return;
    loadStats(profile, selectedMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth]);

  // Paginated count, bucketed per NY calendar day, rather than one big
  // getDocs(limit(N)) - task #122 was exactly this bug at day granularity (a
  // 500-cap silently undercounted a ~5,000-lead bulk day). A full month can
  // easily clear even a much higher single cap for an active account, so
  // this pages through in batches of 2,000 until a short page confirms
  // there's nothing left, instead of picking a bigger-but-still-arbitrary
  // ceiling.
  //
  // Bucketed into a shared `counts` object passed in by the caller, rather
  // than returning its own - the root `messages` collection covers regular
  // sends and manual replies, but the follow-up cron only ever logs a sent
  // follow-up's OWN status onto its `followUps` doc (as "sent" + `sentAt`),
  // never into this root collection - see the near-identical comment on
  // /api/admin/overview's route. A follow-up-only day would otherwise show
  // as 0 here even though real SMS went out, so this same helper is called
  // once per collection/timestamp-field/status-check combo below and both
  // runs add into the same day buckets.
  const accumulateDayCounts = async (
    counts: Record<number, number>,
    collectionName: string,
    timestampField: string,
    uid: string,
    start: Date,
    end: Date,
    isCounted: (status: string) => boolean
  ) => {
    const BATCH_SIZE = 2000;
    const SAFETY_MAX_BATCHES = 200; // 400,000 docs ceiling, just to bound a runaway loop
    let cursor: Date | null = null;

    for (let i = 0; i < SAFETY_MAX_BATCHES; i++) {
      // On every batch after the first, re-querying from `start` again with
      // an inclusive >= would re-include the last doc of the prior batch -
      // nudge the cursor forward a millisecond instead of using startAfter,
      // so this stays a plain field-range query (no extra doc-snapshot
      // bookkeeping needed across the loop).
      const snap = await getDocs(
        query(
          collection(db, collectionName),
          where("ownerUid", "==", uid),
          where(timestampField, ">=", cursor || start),
          where(timestampField, "<", end),
          orderBy(timestampField, "asc"),
          limit(BATCH_SIZE)
        )
      );

      snap.docs.forEach((d) => {
        const data = d.data() as Record<string, any>;
        if (!isCounted(normalizeStatus(data.status))) return;

        const ts = data[timestampField];
        const tsDate = typeof ts?.toDate === "function" ? ts.toDate() : new Date(ts);
        const day = Number(nyDateKey(tsDate).split("-")[2]);
        counts[day] = (counts[day] || 0) + 1;
      });

      if (snap.docs.length < BATCH_SIZE) break;

      const lastDoc = snap.docs[snap.docs.length - 1];
      const lastTs = (lastDoc.data() as Record<string, any>)[timestampField];
      const lastMillis: number =
        typeof lastTs?.toMillis === "function" ? lastTs.toMillis() : new Date(lastTs).getTime();
      cursor = new Date(lastMillis + 1);
    }
  };

  const loadStats = async (profileArg?: AppUser, monthArg?: string) => {
    try {
      setLoading(true);
      setErrorText("");

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setDayCounts({});
        return;
      }

      const { start, end } = getNYMonthRangeUtc(monthArg || selectedMonth);
      const counts: Record<number, number> = {};

      await accumulateDayCounts(
        counts,
        "messages",
        "createdAt",
        currentProfile.uid,
        start,
        end,
        isSuccessfulStatus
      );

      // Follow-ups only ever reach "sent" on their own doc (never
      // "delivered" - their actual delivery status lands on the conversation
      // subcollection message instead, which the block above doesn't touch
      // since it queries the root `messages` collection only).
      await accumulateDayCounts(
        counts,
        "followUps",
        "sentAt",
        currentProfile.uid,
        start,
        end,
        (status) => status === "sent"
      );

      setDayCounts(counts);
      setLoading(false);
    } catch (error: any) {
      console.error("Failed to load stats", error);
      setErrorText(error?.message || "Failed to load stats.");
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  if (checking) {
    return <LoadingScreen />;
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
              <Link
                href="/replies"
                style={{ ...sidebarRepliesCardStyle, position: "relative" }}
              >
                <RepliesNavBadge />
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

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/help" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>🎧</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Help Center</div>
                  <div style={sidebarRepliesTextStyle}>Ask a question, get instant help</div>
                </div>
              </Link>
            </div>
          </div>

          <div style={sidebarBottomLogoutWrapStyle}>
            <div style={{ display: "grid", gap: 12 }}>
              <Link href="/logs" style={sidebarSecondaryLinkButtonStyle}>
                Logs
              </Link>

              <Link href="/stats" style={sidebarSecondaryLinkButtonStyle}>
                Stats
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
                <div style={heroBadgeStyle}>Your Activity</div>
                <h1 style={heroTitleStyle}>Messages Sent</h1>
                <p style={heroTextStyle}>
                  How many of your messages were successfully sent on each day
                  of the month.
                </p>
              </div>

              <div style={controlsRowStyle}>
                <input
                  type="month"
                  value={selectedMonth}
                  max={currentNYMonthString()}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  style={monthInputStyle}
                />

                <button
                  onClick={() => loadStats(undefined, selectedMonth)}
                  style={heroPrimaryButtonStyle}
                >
                  Refresh
                </button>
              </div>
            </div>
          </div>

          {errorText ? <div style={errorBoxStyle}>{errorText}</div> : null}

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <h2 style={panelTitleStyle}>{formatMonthLabel(selectedMonth)}</h2>
              <p style={panelDescStyle}>Successfully sent messages, per day (includes follow-ups)</p>
            </div>

            {loading ? (
              <div style={ringWrapStyle}>
                <div style={spinnerStyle} />
              </div>
            ) : (
              (() => {
                const daysInMonth = getNYMonthRangeUtc(selectedMonth).daysInMonth;
                const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
                const maxCount = Math.max(1, ...days.map((day) => dayCounts[day] || 0));

                return (
                  <div style={barChartWrapStyle}>
                    {days.map((day) => {
                      const count = dayCounts[day] || 0;
                      const heightPct = (count / maxCount) * 100;

                      return (
                        <div key={day} style={barColStyle}>
                          <div style={barCountStyle}>{count > 0 ? count : ""}</div>
                          <div style={barTrackStyle}>
                            <div
                              style={{
                                ...barFillStyle,
                                height: `${Math.max(count > 0 ? 4 : 0, heightPct)}%`,
                              }}
                            />
                          </div>
                          <div style={barDayLabelStyle}>{day}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()
            )}
          </section>
        </section>
      </div>
    </main>
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

const controlsRowStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
};

const monthInputStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 18,
  padding: "14px 16px",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 600,
  colorScheme: "dark",
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

const panelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 28,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  display: "grid",
  gap: 18,
};

const panelHeaderStyle: CSSProperties = {
  textAlign: "center",
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

const ringWrapStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  padding: "12px 0 4px 0",
};

// Full-width bar chart, one bar per day of the month - big enough to read
// at a glance across the whole panel rather than a grid of small tiles.
const barChartWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 6,
  height: 420,
  width: "100%",
  padding: "12px 4px 4px 4px",
};

const barColStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  flex: 1,
  height: "100%",
  minWidth: 0,
};

const barCountStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#0f172a",
  height: 16,
};

const barTrackStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  display: "flex",
  alignItems: "flex-end",
  background: "#f4fbf9",
  borderRadius: 8,
  overflow: "hidden",
};

const barFillStyle: CSSProperties = {
  width: "100%",
  background: "linear-gradient(180deg, #14b8a6 0%, #0f766e 100%)",
  borderRadius: 8,
  transition: "height 0.8s ease-out",
};

const barDayLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#94a3b8",
};

const errorBoxStyle: CSSProperties = {
  borderRadius: 18,
  padding: "14px 16px",
  background: "#7f1d1d",
  color: "#ffffff",
  fontSize: 14,
  lineHeight: 1.5,
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(15, 23, 42, 0.15)",
  borderTop: "3px solid #0d9488",
  animation: "spin 1s linear infinite",
};
