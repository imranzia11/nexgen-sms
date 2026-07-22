"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import LoadingScreen from "../../components/LoadingScreen";

// A simple, deterministic FAQ matcher rather than a live LLM call - this
// answers instantly, costs nothing, can't hallucinate a wrong SMS limit or
// file format rule, and needs no new API key/dependency on a live app. The
// chat-style UI (typing indicator, message bubbles) is purely presentation -
// the underlying answer is still looked up locally, never generated. Each
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
    id: "unknown-error",
    question: "What does an \"unknown error\" on a message mean?",
    category: "Sending",
    keywords: [
      "unknown error",
      "unknown",
      "delivery failed",
      "error while attempting delivery",
      "weird error",
      "strange error",
    ],
    answer:
      "That's a generic delivery-failure code from Twilio (error 30008) - it means the carrier rejected the message without giving a specific reason. It isn't something wrong on our end; it happens occasionally at random across any bulk SMS provider and is usually a temporary carrier-side issue. If you see it a lot for one specific number, it may be worth trying that lead again later.",
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
    answer: "The Stats page shows your account's overall send success count and rate.",
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

// Defined at module scope (not inside the component) so the lint rule that
// flags impure calls "during render" doesn't fire - this is only ever
// invoked from an event handler (askQuestion), never during an actual
// render pass, but the linter can't tell that from inside the component
// body.
function getTypingDelayMs() {
  return 500 + Math.random() * 700;
}

const SUPPORT_URL = "https://wa.me/971523480839";
const FALLBACK_TEXT =
  "I don't have a confident answer for that one yet. Support can help you sort it out directly.";
const GREETING_TEXT =
  "Hi! I'm your Nexgen SMS help assistant. Ask me about sending limits, file format, follow-ups, opt-outs, or anything else - I'll answer instantly, and point you to support if I'm not sure.";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  isFallback?: boolean;
};

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `msg-${Date.now()}-${idCounter}`;
}

export default function HelpPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [userName, setUserName] = useState("User");

  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: nextId(), role: "assistant", text: GREETING_TEXT },
  ]);
  const [isTyping, setIsTyping] = useState(false);

  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isTyping]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    };
  }, []);

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  const handleContactSupport = () => {
    window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
  };

  const askQuestion = (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed || isTyping) return;

    const userMsg: ChatMessage = { id: nextId(), role: "user", text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setQuery("");
    setIsTyping(true);

    const result = findBestMatch(trimmed);

    // A short, realistic "thinking" delay before the answer lands - purely
    // cosmetic (the lookup above is instant), but makes the assistant feel
    // like it's actually reading the question instead of instantly
    // teleporting a canned answer onto the screen.
    const delay = getTypingDelayMs();
    typingTimerRef.current = window.setTimeout(() => {
      const assistantMsg: ChatMessage = result
        ? { id: nextId(), role: "assistant", text: result.answer }
        : { id: nextId(), role: "assistant", text: FALLBACK_TEXT, isFallback: true };

      setMessages((prev) => [...prev, assistantMsg]);
      setIsTyping(false);
    }, delay);
  };

  const handleAsk = (e?: React.FormEvent) => {
    e?.preventDefault();
    askQuestion(query);
  };

  const suggestionChips = useMemo(() => FAQ_ITEMS.map((item) => item.question), []);

  if (checking) {
    return <LoadingScreen text="Loading help center..." />;
  }

  return (
    <main style={pageStyle}>
      <style jsx global>{`
        @keyframes typingDotBounce {
          0%,
          60%,
          100% {
            transform: translateY(0);
            opacity: 0.5;
          }
          30% {
            transform: translateY(-5px);
            opacity: 1;
          }
        }
        @keyframes messagePopIn {
          0% {
            opacity: 0;
            transform: translateY(8px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>

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
          <div style={chatHeaderStyle}>
            <div style={chatHeaderAvatarStyle}>🎧</div>
            <div>
              <div style={chatHeaderTitleStyle}>Help Assistant</div>
              <div style={chatHeaderSubStyle}>
                Answers instantly · escalates to support when unsure
              </div>
            </div>
          </div>

          <div style={chatPanelStyle}>
            <div style={chatMessagesStyle}>
              {messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    ...chatRowStyle,
                    justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  {m.role === "assistant" ? (
                    <div style={chatAvatarSmallStyle}>🎧</div>
                  ) : null}

                  <div
                    style={{
                      ...bubbleBaseStyle,
                      ...(m.role === "user" ? userBubbleStyle : assistantBubbleStyle),
                    }}
                  >
                    {m.text}
                    {m.isFallback ? (
                      <button
                        onClick={handleContactSupport}
                        style={inlineSupportButtonStyle}
                        type="button"
                      >
                        Contact Support
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}

              {isTyping ? (
                <div style={{ ...chatRowStyle, justifyContent: "flex-start" }}>
                  <div style={chatAvatarSmallStyle}>🎧</div>
                  <div style={{ ...bubbleBaseStyle, ...assistantBubbleStyle, ...typingBubbleStyle }}>
                    <span style={{ ...typingDotStyle, animationDelay: "0s" }} />
                    <span style={{ ...typingDotStyle, animationDelay: "0.15s" }} />
                    <span style={{ ...typingDotStyle, animationDelay: "0.3s" }} />
                  </div>
                </div>
              ) : null}

              <div ref={scrollAnchorRef} />
            </div>

            <div style={chipRowStyle}>
              {suggestionChips.map((q) => (
                <button
                  key={q}
                  onClick={() => askQuestion(q)}
                  style={chipStyle}
                  type="button"
                  disabled={isTyping}
                >
                  {q}
                </button>
              ))}
            </div>

            <form onSubmit={handleAsk} style={chatInputRowStyle}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask a question..."
                style={chatInputStyle}
                disabled={isTyping}
              />
              <button type="submit" style={chatSendButtonStyle} disabled={isTyping || !query.trim()}>
                Send
              </button>
            </form>
          </div>

          <button onClick={handleContactSupport} style={footerSupportButtonStyle} type="button">
            Still stuck? Contact Support directly
          </button>
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
  gap: 16,
  gridTemplateRows: "auto 1fr auto",
  height: "100vh",
};

const chatHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  borderRadius: 24,
  padding: "18px 22px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 20px 50px rgba(13, 148, 136, 0.22)",
};

const chatHeaderAvatarStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.18)",
  fontSize: 22,
  flexShrink: 0,
};

const chatHeaderTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 20,
  fontWeight: 900,
};

const chatHeaderSubStyle: CSSProperties = {
  marginTop: 4,
  color: "rgba(236,254,255,0.85)",
  fontSize: 13,
};

const chatPanelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.92)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  display: "grid",
  gridTemplateRows: "1fr auto auto",
  minHeight: 0,
  overflow: "hidden",
};

const chatMessagesStyle: CSSProperties = {
  padding: "22px 22px 8px 22px",
  overflowY: "auto",
  display: "grid",
  gap: 14,
  minHeight: 0,
};

const chatRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 10,
  animation: "messagePopIn 0.25s ease-out",
};

const chatAvatarSmallStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 15,
  flexShrink: 0,
};

const bubbleBaseStyle: CSSProperties = {
  maxWidth: "70%",
  padding: "14px 16px",
  borderRadius: 20,
  fontSize: 14.5,
  lineHeight: 1.6,
};

const assistantBubbleStyle: CSSProperties = {
  background: "#f1f5f9",
  color: "#0f172a",
  borderBottomLeftRadius: 6,
};

const userBubbleStyle: CSSProperties = {
  background: "#0d9488",
  color: "#ffffff",
  borderBottomRightRadius: 6,
};

const typingBubbleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "16px 18px",
};

const typingDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "#64748b",
  display: "inline-block",
  animation: "typingDotBounce 1.1s infinite ease-in-out",
};

const inlineSupportButtonStyle: CSSProperties = {
  display: "block",
  marginTop: 12,
  border: "none",
  borderRadius: 14,
  padding: "10px 16px",
  background: "#0f172a",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 13,
  cursor: "pointer",
};

const chipRowStyle: CSSProperties = {
  padding: "10px 22px",
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  borderTop: "1px solid rgba(15,23,42,0.06)",
  maxHeight: 96,
  overflowY: "auto",
};

const chipStyle: CSSProperties = {
  border: "1px solid rgba(13,148,136,0.3)",
  borderRadius: 999,
  padding: "8px 14px",
  background: "rgba(13,148,136,0.06)",
  color: "#0d9488",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const chatInputRowStyle: CSSProperties = {
  padding: 18,
  borderTop: "1px solid rgba(15,23,42,0.06)",
  display: "flex",
  gap: 12,
};

const chatInputStyle: CSSProperties = {
  flex: 1,
  border: "1px solid rgba(15,23,42,0.12)",
  borderRadius: 16,
  padding: "14px 16px",
  fontSize: 14.5,
  outline: "none",
  background: "#f8fafc",
  color: "#0f172a",
};

const chatSendButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 16,
  padding: "14px 24px",
  background: "#0d9488",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
};

const footerSupportButtonStyle: CSSProperties = {
  justifySelf: "start",
  border: "1px solid rgba(15,23,42,0.1)",
  borderRadius: 14,
  padding: "10px 18px",
  background: "#ffffff",
  color: "#0d9488",
  fontWeight: 800,
  fontSize: 13,
  cursor: "pointer",
};
