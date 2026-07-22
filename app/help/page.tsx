"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useEffect } from "react";
import { auth, db } from "../../lib/firebase";
import LoadingScreen from "../../components/LoadingScreen";

// A simple, deterministic FAQ matcher rather than a live LLM call - this
// answers instantly, costs nothing, can't hallucinate a wrong SMS limit or
// file format rule, and needs no new API key/dependency on a live app. Each
// answer below reflects the ACTUAL current behavior of this system (see
// app/dashboard/page.tsx SEND_CHUNK_SIZE, getUSPhoneValidation,
// guessPhoneColumn; app/api/cron/send-followups/route.ts; and
// app/api/send-sms/twilio/status/route.ts) - if any of that logic changes,
// update the matching answer here too.

type FaqItem = {
  id: string;
  question: string;
  category: string;
  keywords: string[];
  answer: string;
};

const FAQ_ITEMS: FaqItem[] = [
  {
    id: "sms-limit",
    question: "How many SMS can I send at once?",
    category: "Sending",
    keywords: [
      "how many",
      "sms",
      "text",
      "limit",
      "send",
      "max",
      "maximum",
      "cap",
      "bulk",
      "blast",
      "leads",
      "large",
      "thousand",
    ],
    answer:
      "There's no hard cap on list size - campaigns of several thousand leads run fine. To keep sends reliable, the system automatically splits your list into batches of 150 and sends them one batch after another, fetching a fresh batch each time. A progress screen shows \"Batch X of Y\" so you can see it moving. Please don't close or refresh the page until it says the send is finished - closing mid-send can interrupt batches still in progress.",
  },
  {
    id: "file-format",
    question: "What file format should my lead list be?",
    category: "Uploading leads",
    keywords: [
      "file",
      "format",
      "csv",
      "excel",
      "xlsx",
      "upload",
      "spreadsheet",
      "column",
      "header",
      "leads file",
    ],
    answer:
      "Upload a .csv file with a header row. The phone number column is detected automatically by name (phone, phone_number, mobile, contact, number, cell, or whatsapp) - if none of those match, the first column is used. Phone numbers should be US numbers: a plain 10-digit number, 11 digits starting with 1, or already formatted as +1XXXXXXXXXX. Add a Name / Full Name / Customer Name / First Name column if you want it available for personalization.",
  },
  {
    id: "invalid-numbers",
    question: "What happens to invalid phone numbers in my list?",
    category: "Uploading leads",
    keywords: [
      "invalid",
      "verify",
      "verified",
      "unverified",
      "wrong number",
      "bad number",
      "validation",
      "not sent",
    ],
    answer:
      "Every number is checked against the US format as soon as you upload. Numbers that don't match are marked unverified and are automatically excluded from sending - only verified numbers actually get texted.",
  },
  {
    id: "follow-ups",
    question: "How do follow-up messages work?",
    category: "Follow-ups",
    keywords: [
      "follow up",
      "followup",
      "follow-up",
      "reminder",
      "second message",
      "hours",
      "auto message",
    ],
    answer:
      "Turn on the follow-up checkbox before sending and choose how many hours later it should go out. A background job checks every ~15 minutes for follow-ups that are due and sends them automatically. Follow-ups are skipped for numbers that are blocked or opted out (replied STOP), and for any original message that permanently failed to deliver.",
  },
  {
    id: "opt-out",
    question: "How does opt-out / STOP work?",
    category: "Compliance",
    keywords: [
      "stop",
      "opt out",
      "opt-out",
      "unsubscribe",
      "block",
      "blacklist",
      "blocked",
      "do not contact",
    ],
    answer:
      "If a customer replies STOP, their number is automatically blocked from receiving any future messages. You can view and manage every blocked number on the Blacklisted page.",
  },
  {
    id: "delivery-status",
    question: "Where can I see if my messages were delivered?",
    category: "Tracking",
    keywords: [
      "delivered",
      "delivery",
      "status",
      "sent",
      "failed",
      "logs",
      "track",
      "history",
      "undelivered",
    ],
    answer:
      "The Logs page shows every message for a chosen day, marked simply as Success or Failed - messages still in flight aren't shown until they finish.",
  },
  {
    id: "templates",
    question: "Can I save and reuse message templates?",
    category: "Messaging",
    keywords: [
      "template",
      "templates",
      "reuse",
      "save message",
      "personalize",
      "personalization",
    ],
    answer:
      "Yes - save a message as a template from the dashboard, then pick it again later for any future campaign instead of retyping it.",
  },
  {
    id: "why-progress-screen",
    question: "Why do I see a loading screen when I click send?",
    category: "Sending",
    keywords: [
      "loading",
      "progress",
      "screen",
      "refresh",
      "don't close",
      "stuck",
      "frozen",
      "spinner",
    ],
    answer:
      "For larger sends, messages go out in batches of 150 to keep the send reliable. The progress screen shows which batch is currently in flight and how many messages have gone out so far. Please don't refresh or close the tab until it's done - doing so can interrupt batches still in progress.",
  },
  {
    id: "stats",
    question: "Where can I see my overall sending stats?",
    category: "Tracking",
    keywords: ["stats", "statistics", "success rate", "overview", "total sent"],
    answer:
      "The Stats page shows your account's overall send success count and rate.",
  },
];

function normalize(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreFaq(query: string, item: FaqItem) {
  const q = normalize(query);
  if (!q) return 0;

  let score = 0;
  const questionNorm = normalize(item.question);

  for (const keyword of item.keywords) {
    if (q.includes(normalize(keyword))) score += 2;
  }

  const queryWords = new Set(q.split(" ").filter((w) => w.length > 2));
  const questionWords = questionNorm.split(" ").filter((w) => w.length > 2);
  for (const w of questionWords) {
    if (queryWords.has(w)) score += 1;
  }

  return score;
}

function findBestMatch(query: string) {
  let best: FaqItem | null = null;
  let bestScore = 0;

  for (const item of FAQ_ITEMS) {
    const s = scoreFaq(query, item);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }

  // Require at least one real signal - an empty/garbage query or one that
  // shares nothing with any FAQ should fall through to "contact support"
  // rather than guessing at the weakest match.
  return bestScore >= 2 ? best : null;
}

const SUPPORT_URL = "https://wa.me/971523480839";

export default function HelpPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [userName, setUserName] = useState("User");

  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [matched, setMatched] = useState<FaqItem | null>(null);

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
        const safeName =
          String(userData.name || "").trim() ||
          String(user.displayName || "").trim() ||
          String(user.email || "").split("@")[0] ||
          "User";

        setUserName(safeName);
        setChecking(false);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  const handleAsk = (e?: React.FormEvent) => {
    e?.preventDefault();
    const result = findBestMatch(query);
    setMatched(result);
    setSearched(true);
  };

  const handlePickFaq = (item: FaqItem) => {
    setQuery(item.question);
    setMatched(item);
    setSearched(true);
  };

  const handleContactSupport = () => {
    window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
  };

  const categories = useMemo(() => {
    const map = new Map<string, FaqItem[]>();
    for (const item of FAQ_ITEMS) {
      const list = map.get(item.category) || [];
      list.push(item);
      map.set(item.category, list);
    }
    return Array.from(map.entries());
  }, []);

  if (checking) {
    return <LoadingScreen text="Loading help center..." />;
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

              <Link href="/stats" style={sidebarSecondaryLinkButtonStyle}>
                Stats
              </Link>

              <Link href="/help" style={sidebarSecondaryLinkButtonStyle}>
                Help Center
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
                <div style={heroBadgeStyle}>Help Center</div>
                <h1 style={heroTitleStyle}>Ask a question</h1>
                <p style={heroTextStyle}>
                  Ask about SMS sending limits, file format, follow-ups, and
                  more. If there&apos;s no good answer here, we&apos;ll point
                  you to support.
                </p>
              </div>

              <form onSubmit={handleAsk} style={askFormStyle}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. How many SMS can I send? What file format do I upload?"
                  style={askInputStyle}
                />
                <button type="submit" style={askButtonStyle}>
                  Ask
                </button>
              </form>
            </div>
          </div>

          {searched ? (
            <section style={panelStyle}>
              {matched ? (
                <div>
                  <div style={panelHeaderStyle}>
                    <div>
                      <h2 style={panelTitleStyle}>{matched.question}</h2>
                    </div>
                  </div>
                  <p style={answerTextStyle}>{matched.answer}</p>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 14 }}>
                  <div>
                    <h2 style={panelTitleStyle}>
                      We don&apos;t have an answer for that yet
                    </h2>
                    <p style={panelDescStyle}>
                      Reach out to support directly and we&apos;ll help you
                      sort it out.
                    </p>
                  </div>
                  <button
                    onClick={handleContactSupport}
                    style={contactSupportButtonStyle}
                    type="button"
                  >
                    Contact Support
                  </button>
                </div>
              )}
            </section>
          ) : null}

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Browse common questions</h2>
                <p style={panelDescStyle}>
                  Tap any question for an instant answer.
                </p>
              </div>
            </div>

            <div style={{ marginTop: 18, display: "grid", gap: 22 }}>
              {categories.map(([category, items]) => (
                <div key={category}>
                  <div style={categoryLabelStyle}>{category}</div>
                  <div style={cardGridStyle}>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => handlePickFaq(item)}
                        style={faqCardStyle}
                        type="button"
                      >
                        {item.question}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>Still need help?</h2>
                <p style={panelDescStyle}>
                  Get in touch and we&apos;ll help with anything not covered
                  here.
                </p>
              </div>
              <button
                onClick={handleContactSupport}
                style={contactSupportButtonStyle}
                type="button"
              >
                Contact Support
              </button>
            </div>
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

const askFormStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  flexWrap: "wrap",
};

const askInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 280,
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 18,
  padding: "16px 18px",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontSize: 15,
  outline: "none",
};

const askButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "16px 26px",
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
  fontSize: 22,
  fontWeight: 900,
  color: "#0f172a",
};

const panelDescStyle: CSSProperties = {
  margin: "8px 0 0 0",
  color: "#64748b",
  fontSize: 14,
  lineHeight: 1.5,
};

const answerTextStyle: CSSProperties = {
  marginTop: 14,
  color: "#334155",
  fontSize: 15,
  lineHeight: 1.7,
};

const categoryLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#0d9488",
  marginBottom: 10,
};

const cardGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 12,
};

const faqCardStyle: CSSProperties = {
  textAlign: "left",
  borderRadius: 18,
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15,23,42,0.08)",
  padding: "16px 16px",
  boxShadow: "0 10px 24px rgba(15,23,42,0.05)",
  color: "#0f172a",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1.4,
};

const contactSupportButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 16,
  padding: "14px 22px",
  background: "#0d9488",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
