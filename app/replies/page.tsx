"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  getCountFromServer,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  doc,
  where,
  orderBy,
  limit,
  deleteDoc,
  setDoc,
  serverTimestamp,
  type Query,
  type DocumentData,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";
import { formatFirestoreDateNY } from "../../lib/date";
import { logDeletion } from "../../lib/deletionLog";
import { phoneDocId } from "../../lib/phone";
import {
  enableNotifications,
  listenForForegroundReplies,
  syncAppBadge,
} from "../../lib/pushClient";

type SmsRow = {
  id: string;
  phone: string;
  name?: string;
  body: string;
  createdAtLabel: string;
  sortSeconds: number;
  hasReply: boolean;
  lastDirection: string;
  pinned: boolean;
  lastOutboundStatus: string;
  // True only for numbers someone on the team deliberately blocked via the
  // Block button - NOT for customers who texted STOP. Those stay fully
  // hidden from this list, same as always. A manually-blocked conversation
  // moves to the dedicated "Attention Required" tab (see attentionItems)
  // instead of its normal tab, and renders red with an Unblock action
  // instead of Block.
  manuallyBlocked: boolean;
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

// One pending follow-up (from the `followUps` collection - see
// app/api/schedule-follow-up/route.ts and app/api/cron/send-followups/
// route.ts). Deliberately a separate shape from SmsRow: a follow-up isn't a
// conversation, it's a queued outbound message with its own due time.
type FollowUpRow = {
  id: string;
  phone: string;
  message: string;
  campaignName: string;
  dueAtMs: number;
  delayHours: number;
};

type FilterMode =
  | "all"
  | "replied"
  | "awaiting"
  | "never_replied"
  | "pinned"
  | "failed"
  | "attention"
  | "followups";

// Matches the same failed/undelivered statuses used to render the red
// error bubble on the /replies/[phone] thread view.
function isFailedOutboundStatus(status: string) {
  return status === "failed" || status === "undelivered";
}

// The single number shown on the compact mobile header/stat line for
// whichever tab is currently active - avoids repeating this switch at
// every call site that needs "the count for the tab you're looking at".
function activeTabCount(
  mode: FilterMode,
  counts: StatCounts,
  attentionCount: number,
  followUpsCount: number = 0
): number {
  switch (mode) {
    case "all":
      return counts.all;
    case "replied":
      return counts.replied;
    case "awaiting":
      return counts.awaiting;
    case "never_replied":
      return counts.neverReplied;
    case "pinned":
      return counts.pinned;
    case "failed":
      return counts.failed;
    case "attention":
      return attentionCount;
    case "followups":
      return followUpsCount;
    default:
      return 0;
  }
}

// Human-readable label for the compact mobile header subtitle - keeps
// wording in exactly one place instead of duplicating each tab's name.
function filterModeLabel(mode: FilterMode): string {
  switch (mode) {
    case "all":
      return "All sent SMS";
    case "replied":
      return "Customer replied";
    case "awaiting":
      return "Waiting for customer";
    case "never_replied":
      return "Never replied";
    case "pinned":
      return "Pinned messages";
    case "failed":
      return "Failed / undelivered";
    case "attention":
      return "Attention required";
    case "followups":
      return "Follow-ups";
    default:
      return "";
  }
}

// Module-level cache: survives across client-side navigations within the
// same session (not across full page reloads). Lets us paint the list
// instantly on repeat visits while a fresh fetch quietly runs underneath
// (stale-while-revalidate), instead of showing a loading state every time.
const repliesCache = new Map<
  string,
  { items: SmsRow[]; blocked: string[]; ts: number }
>();

// --- Persisted (localStorage) cache -----------------------------------
// The module-level Map above only survives client-side navigation. A hard
// refresh of the browser tab wipes it, which is exactly when the old
// skeleton screen used to reappear every single time. Mirroring the same
// cache into localStorage means a returning visitor - even after closing
// the tab - gets an instant paint instead of a loading screen, while we
// still validate their session and refresh the data quietly underneath.
const CACHE_STORAGE_KEY = "sms_replies_cache_v1";
const NETWORK_TIMEOUT_MS = 12000;

type PersistedCache = {
  uid: string;
  items: SmsRow[];
  blocked: string[];
  ts: number;
};

function readPersistedCache(): PersistedCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.uid !== "string" ||
      !Array.isArray(parsed.items)
    ) {
      return null;
    }
    return parsed as PersistedCache;
  } catch {
    return null;
  }
}

function writePersistedCache(uid: string, items: SmsRow[], blocked: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CACHE_STORAGE_KEY,
      JSON.stringify({ uid, items, blocked, ts: Date.now() })
    );
  } catch {
    // Private browsing / storage quota can throw here. Safe to ignore -
    // the in-memory cache still keeps same-session navigation instant.
  }
}

function setCache(uid: string, items: SmsRow[], blocked: string[]) {
  repliesCache.set(uid, { items, blocked, ts: Date.now() });
  writePersistedCache(uid, items, blocked);
}

function getCache(uid: string) {
  const inMemory = repliesCache.get(uid);
  if (inMemory) return inMemory;

  const persisted = readPersistedCache();
  if (persisted && persisted.uid === uid) {
    repliesCache.set(uid, {
      items: persisted.items,
      blocked: persisted.blocked,
      ts: persisted.ts,
    });
    return repliesCache.get(uid);
  }

  return undefined;
}

// Only trust the persisted cache for the very first synchronous render if
// it demonstrably belongs to whoever is actually signed in right now. The
// localStorage key above is shared by the whole browser, not scoped per
// account — without this check, whichever account last wrote to it gets
// painted on screen immediately for ANY account that loads this page next,
// until the auth check a moment later corrects it. That's the "flicker"
// where the page briefly shows one person's conversations before
// snapping to another's: Firebase Auth persists the session, so
// auth.currentUser is already populated synchronously for an
// already-logged-in user by the time this runs — we just have to actually
// check it instead of trusting the cache unconditionally.
function getInitialCache(): PersistedCache | null {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) return null;

  const persisted = readPersistedCache();
  if (persisted && persisted.uid === currentUid) return persisted;

  return null;
}

// --- Stat-card counts ----------------------------------------------------
// The 6 header numbers (All/Replied/Waiting/Never Replied/Pinned/Failed)
// used to be derived from the exact same full-collection download that
// powers the conversation list below - meaning every visit had to wait for
// every one of your conversations to be downloaded just to show 6 numbers.
// This computes them instead with Firestore's server-side count() queries,
// which return just an integer without downloading any documents, so this
// stays fast no matter how large the conversations collection grows.
// Cached the same way as the list (instant paint from last-known values,
// refreshed quietly underneath) since count queries, while fast, still
// take a moment over the network.
type StatCounts = {
  all: number;
  replied: number;
  // Of `replied` above, how many are also pinned - i.e. how many are
  // counted in the "Customer Replied" number/badge but NOT shown in the
  // "Customer Replied" tab's own list (they live under "Pinned Messages"
  // instead). Purely for the "includes N pinned" hint under the stat
  // card, so the gap between the number and the visible list is
  // self-explanatory instead of looking like a bug.
  pinnedReplied: number;
  awaiting: number;
  neverReplied: number;
  pinned: number;
  failed: number;
};

const ZERO_COUNTS: StatCounts = {
  all: 0,
  replied: 0,
  pinnedReplied: 0,
  awaiting: 0,
  neverReplied: 0,
  pinned: 0,
  failed: 0,
};

const COUNTS_CACHE_KEY = "sms_replies_counts_cache_v1";

type PersistedCounts = { uid: string; counts: StatCounts; ts: number };

function readPersistedCounts(): PersistedCounts | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COUNTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.uid !== "string" || !parsed.counts) return null;
    return parsed as PersistedCounts;
  } catch {
    return null;
  }
}

function writePersistedCounts(uid: string, counts: StatCounts) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COUNTS_CACHE_KEY,
      JSON.stringify({ uid, counts, ts: Date.now() })
    );
  } catch {
    // Private browsing / storage quota - safe to ignore.
  }
}

function getInitialCounts(): StatCounts {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) return ZERO_COUNTS;

  const persisted = readPersistedCounts();
  // Spread over ZERO_COUNTS so a cache written by an older version of this
  // page (missing a field we've since added, e.g. pinnedReplied) still
  // yields a valid number instead of `undefined` leaking into the UI.
  if (persisted && persisted.uid === currentUid) {
    return { ...ZERO_COUNTS, ...persisted.counts };
  }

  return ZERO_COUNTS;
}

// Wraps a promise with a hard ceiling so a dead network connection can
// never leave the page stuck on a loading state forever. Firestore calls
// that never resolve (rather than erroring) are the usual cause of a
// "stuck loading" screen - this guarantees we always fall through to an
// error/retry state instead of spinning indefinitely.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// "Sends in 3h 24m" / "Overdue by 1h 5m" - used on the Follow-Ups tab.
// Deliberately doesn't hide the overdue case: since nothing currently runs
// the send-followups cron automatically (see chat/task #82's Cloud
// Scheduler gap), a follow-up sitting overdue is real, useful information,
// not a bug in this display.
function formatFollowUpCountdown(dueAtMs: number, nowMs: number): {
  label: string;
  overdue: boolean;
} {
  if (!dueAtMs) return { label: "Unknown", overdue: false };

  const diffMs = dueAtMs - nowMs;
  const overdue = diffMs < 0;
  const absMs = Math.abs(diffMs);

  const totalMinutes = Math.round(absMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const duration =
    hours > 0 ? `${hours}h ${minutes}m` : `${Math.max(minutes, 1)}m`;

  return {
    label: overdue ? `Overdue by ${duration}` : `Sends in ${duration}`,
    overdue,
  };
}

function truncateText(value: string, max = 110) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
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

function normalizeDirection(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function blacklistDocId(ownerUid: string, phone: string) {
  return `${ownerUid}_${phoneKey(phone)}`;
}

// Distinguishes a staff-initiated manual block from a customer's own STOP
// (or auto-detected abuse) opt-out. The inbound webhook writes
// reason: "opt_out" / "abusive_language" / "resubscribe"; the manual Block
// button on this page writes reason: "manual_block". Only manual blocks
// should stay visible-but-flagged here - STOP is a legal opt-out and stays
// fully hidden, unchanged from today.
function isManualBlockRecord(data: Record<string, any>) {
  return (
    String(data.reason || "").toLowerCase() === "manual_block" ||
    String(data.source || "").toLowerCase() === "manual_block_from_replies"
  );
}

// Default browsing view (no search term typed) - fetch only the most
// recent DEFAULT_LIST_LIMIT conversations matching whatever tab is active,
// instead of every conversation the account has ever had. "Load more"
// bumps the limit by LIST_LIMIT_STEP, which simply re-subscribes with a
// bigger number - simpler than cursor pagination and still avoids ever
// downloading more than what's actually been asked for.
const DEFAULT_LIST_LIMIT = 50;
const LIST_LIMIT_STEP = 50;

// Render-side page size for the conversation cards themselves - see the
// `page` state above for why this is separate from DEFAULT_LIST_LIMIT
// (which governs how much is fetched, currently disabled - see
// SCOPED_LIST_ENABLED below).
const REPLIES_PAGE_SIZE = 20;

// Re-enabled a 2nd time after root-causing the "Waiting for Customer"
// regression: the browser console showed "FirebaseError: The query
// requires an index" - the composite indexes were declared in
// firestore.indexes.json but had never actually been deployed to the live
// Firestore project. Ran `firebase deploy --only firestore:indexes`, then
// confirmed directly in the Firebase console (Firestore > Indexes) that
// all 5 `conversations` composite indexes now show "Enabled" (not
// "Building"). Field completeness (lastMessageAt/blocked/hasReply/
// lastDirection) was already confirmed 100% earlier. Both conditions are
// now satisfied.
const SCOPED_LIST_ENABLED = true;

// Deliberately does NOT filter `pinned != true` on the non-pinned tabs -
// Firestore excludes any document missing a filtered field entirely, and
// most conversations never have `pinned` set at all (same class of bug as
// the earlier `blocked` field incident). Pinned items are instead stripped
// out client-side (see the `nonPinned` step in filteredItems below), same
// as before this change - just now operating on a small scoped batch
// instead of the full account.
function buildScopedConversationsQuery(
  ownerUid: string,
  mode: FilterMode,
  limitN: number
) {
  const col = collection(db, "conversations");
  const base = [where("ownerUid", "==", ownerUid), where("blocked", "==", false)];

  if (mode === "pinned") {
    return query(
      col,
      ...base,
      where("pinned", "==", true),
      orderBy("lastMessageAt", "desc"),
      limit(limitN)
    );
  }

  if (mode === "replied") {
    return query(
      col,
      ...base,
      where("hasReply", "==", true),
      where("lastDirection", "==", "inbound"),
      orderBy("lastMessageAt", "desc"),
      limit(limitN)
    );
  }

  if (mode === "awaiting") {
    return query(
      col,
      ...base,
      where("hasReply", "==", true),
      where("lastDirection", "==", "outbound"),
      orderBy("lastMessageAt", "desc"),
      limit(limitN)
    );
  }

  if (mode === "never_replied") {
    return query(
      col,
      ...base,
      where("hasReply", "==", false),
      orderBy("lastMessageAt", "desc"),
      limit(limitN)
    );
  }

  if (mode === "failed") {
    return query(
      col,
      ...base,
      where("lastOutboundStatus", "in", ["failed", "undelivered"]),
      orderBy("lastMessageAt", "desc"),
      limit(limitN)
    );
  }

  return query(col, ...base, orderBy("lastMessageAt", "desc"), limit(limitN));
}

// Defensive re-filter applied to anything painted from the persisted
// (localStorage) cache - the cache stores its own `blocked` snapshot
// alongside the items, but if that cache was ever written before a number
// was blacklisted (or from a build that had a filtering bug), the
// instant-paint step would otherwise flash an opted-out conversation for a
// moment before the live listener corrects it a beat later. Re-applying
// the exact same exclusion buildRows() already does - using whatever
// blocked list is cached right alongside those items - makes the very
// first paint self-consistent instead of trusting it blindly.
function filterOutBlockedRows(items: SmsRow[], blocked: string[]): SmsRow[] {
  if (!blocked || blocked.length === 0) return items;
  const blockedSet = new Set(blocked.map((phone) => phoneKey(phone)));
  return items.filter((item) => !blockedSet.has(phoneKey(item.phone)));
}

function makeRow(id: string, data: Record<string, any>): SmsRow {
  const phone = String(
    data.phone || data.customerPhone || data.to || data.contactPhone || ""
  ).trim();

  const lastDirection = normalizeDirection(data.lastDirection || data.direction);

  const displayDate =
    data.lastMessageAt || data.updatedAt || data.createdAt || null;

  return {
    id,
    phone,
    name: String(data.name || data.customerName || ""),
    body: String(data.lastMessage || data.body || ""),
    createdAtLabel: formatFirestoreDateNY(displayDate),
    sortSeconds: getSortSeconds(displayDate),
    hasReply: data.hasReply === true,
    lastDirection,
    pinned: data.pinned === true,
    lastOutboundStatus: String(data.lastOutboundStatus || "")
      .trim()
      .toLowerCase(),
    manuallyBlocked: false,
  };
}

export default function RepliesPage() {
  const router = useRouter();

  const [items, setItems] = useState<SmsRow[]>(() => {
    const initial = getInitialCache();
    if (!initial) return [];
    return filterOutBlockedRows(initial.items, initial.blocked);
  });
  const [loading, setLoading] = useState<boolean>(() => !getInitialCache());
  const [checking, setChecking] = useState<boolean>(() => !getInitialCache());
  const [authTimedOut, setAuthTimedOut] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  // Anything non-empty in the search box switches the list from the fast,
  // tab-scoped live query back to a one-time full-history fetch - see the
  // live-listener effect further down for exactly how that's used.
  const isSearching = search.trim().length > 0;
  // Staff checking replies from their phone (via the installed home-screen
  // app - see app/manifest.ts) never need a way back to the full desktop
  // dashboard; hiding it keeps that experience feeling like a dedicated
  // Replies app rather than a shrunk-down admin panel. Desktop is
  // unaffected either way.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const MOBILE_BREAKPOINT = 880;
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // "Switch to Mobile" popup (desktop only) - same scan-to-open QR code as
  // the login page, just reachable from here too since a desktop user is
  // already looking at Replies and may want to hand off to their phone
  // without navigating away first. siteOrigin starts empty and fills in
  // after mount for the same reason as the login page's version: reading
  // window.location during the initial render would mismatch between the
  // server-rendered HTML and the client's first render.
  const [showMobileQr, setShowMobileQr] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState("");
  useEffect(() => {
    setSiteOrigin(window.location.origin);
  }, []);

  // Push notifications ("customer replied" alerts + app icon badge, like
  // WhatsApp) for the installed home-screen app. Entirely additive: if
  // notifications are unsupported, not yet enabled, or fail for any
  // reason, the rest of the page behaves exactly as it already did -
  // nothing here can affect loading, sending, or displaying replies.
  const [notifPermission, setNotifPermission] = useState<
    "unknown" | "granted" | "denied" | "unsupported"
  >("unknown");
  const [enablingNotifs, setEnablingNotifs] = useState(false);

  useEffect(() => {
    if (typeof Notification === "undefined") {
      setNotifPermission("unsupported");
      return;
    }
    setNotifPermission(Notification.permission === "granted" ? "granted" : "unknown");
  }, []);

  async function handleEnableNotifications() {
    setEnablingNotifs(true);
    try {
      const result = await enableNotifications();
      if (result.ok) {
        setNotifPermission("granted");
      } else if (result.reason === "denied") {
        setNotifPermission("denied");
      } else if (result.reason === "unsupported") {
        setNotifPermission("unsupported");
      }
    } finally {
      setEnablingNotifs(false);
    }
  }
  const [blockedPhones, setBlockedPhones] = useState<string[]>(
    () => getInitialCache()?.blocked || []
  );
  // Manually-blocked conversations used to stay inline in whatever tab
  // they'd normally sort into (marked red, not removed) - but that relied
  // on the tab query fetching every conversation regardless of `blocked`.
  // Once the scoped, tab-limited queries (SCOPED_LIST_ENABLED) filter
  // where("blocked","==",false) server-side, a manually-blocked
  // conversation is excluded from every tab's results entirely - it would
  // otherwise just vanish instead of showing with its red "Blocked" marker.
  // Given a dedicated tab, sourced the same way the sidebar's attention
  // mark already works (useManuallyBlockedAttention.ts): a small, targeted
  // set of per-phone lookups from the manual-block blacklist entries,
  // never a full collection scan.
  const [attentionItems, setAttentionItems] = useState<SmsRow[]>([]);

  // Follow-Ups tab: every `followUps` doc still `status: "pending"` for
  // this owner, minus any number that's since ended up on the blacklist
  // (STOP reply, abuse auto-block, or manual block) - those will never
  // actually be sent (the cron skips blocked numbers at send time), so
  // showing them here as "sends in 3h" would be misleading. skippedCount
  // tracks how many were excluded that way, purely for a small "N blocked,
  // won't send" hint under the stat card/tab.
  const [followUpItems, setFollowUpItems] = useState<FollowUpRow[]>([]);
  const [followUpsSkippedCount, setFollowUpsSkippedCount] = useState(0);

  // Ticking clock for the "sends in Xh Ym" / "overdue" countdown text -
  // updated every 30s, which is plenty granular for a delay measured in
  // hours and avoids a per-second re-render for a whole list of rows.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const [profile, setProfile] = useState<AppUser | null>(null);
  const [counts, setCounts] = useState<StatCounts>(() => getInitialCounts());

  useEffect(() => {
    if (!profile) return;
    const stop = listenForForegroundReplies((link) => router.push(link));
    return stop;
  }, [profile, router]);

  // Keeps the home-screen icon badge in sync with the exact same
  // "Customer Replied" number the app already shows in its own stat card -
  // no separate source of truth, no risk of the two ever disagreeing.
  useEffect(() => {
    syncAppBadge(counts.replied);
  }, [counts.replied]);
  const [filterMode, setFilterMode] = useState<FilterMode>("replied");
  const [listLimit, setListLimit] = useState(DEFAULT_LIST_LIMIT);
  // Purely a render-side page (client-side slice of whatever's already
  // been fetched/filtered) - doesn't change what's downloaded from
  // Firestore, just how many rows get turned into DOM nodes at once. A
  // tab like "Never Replied" can have tens of thousands of matches; with
  // no pagination every single one became a card in the page, which is
  // what made scrolling/rendering heavy even after the data itself
  // arrived quickly.
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState("");
  const [blockingId, setBlockingId] = useState("");
  const [openMenuId, setOpenMenuId] = useState("");
  const [pinningId, setPinningId] = useState("");

  const [selectedPhones, setSelectedPhones] = useState<string[]>([]);
  const [followUpMessage, setFollowUpMessage] = useState("");
  const [sendingBulk, setSendingBulk] = useState(false);

  const profileRef = useRef<AppUser | null>(null);

  async function runQuery(q: Query<DocumentData>) {
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      data: d.data() as Record<string, any>,
    }));
  }

  async function fetchBlacklist(currentProfile: AppUser) {
    // Always scoped to the signed-in user's own uid. There used to be an
    // isAdmin() branch here that queried the whole collection unfiltered —
    // Firestore's rules don't grant admins any read exception, so that
    // branch would only ever throw a permission error, never actually
    // return everyone's data. Removed rather than left as a landmine for
    // a future rules change to accidentally activate.
    const blacklistSnap = await getDocs(
      query(
        collection(db, "blacklisted_numbers"),
        where("ownerUid", "==", currentProfile.uid)
      )
    );

    const blocked: string[] = [];
    const manuallyBlocked: string[] = [];

    blacklistSnap.docs.forEach((d) => {
      const data = d.data();
      if (String(data.status || "").toLowerCase() !== "blocked") return;
      const phone = String(data.phone || "").trim();
      if (!phone) return;
      if (isManualBlockRecord(data)) {
        manuallyBlocked.push(phone);
      } else {
        blocked.push(phone);
      }
    });

    return { blocked, manuallyBlocked };
  }

  async function fetchConversations(currentProfile: AppUser) {
    // Same reasoning as fetchBlacklist above — always scoped to the
    // signed-in user's own uid, no admin bypass.
    return runQuery(
      query(
        collection(db, "conversations"),
        where("ownerUid", "==", currentProfile.uid)
      )
    );
  }

  function buildRows(
    docs: Array<{ id: string; data: Record<string, any> }>,
    blocked: string[],
    manuallyBlocked: string[] = []
  ) {
    const blockedSet = new Set(blocked.map((phone) => phoneKey(phone)));
    const manuallyBlockedSet = new Set(
      manuallyBlocked.map((phone) => phoneKey(phone))
    );

    return docs
      .map((row) => makeRow(row.id, row.data))
      .filter((item) => {
        const p = phoneKey(item.phone);
        if (!p) return false;
        // STOP/abuse opt-outs stay fully hidden. Manual blocks are NOT
        // filtered out here - they stay in the list, just flagged below.
        if (blockedSet.has(p)) return false;
        return true;
      })
      .map((item) => {
        const p = phoneKey(item.phone);
        return manuallyBlockedSet.has(p) ? { ...item, manuallyBlocked: true } : item;
      })
      .sort((a, b) => b.sortSeconds - a.sortSeconds);
  }

  // Fast path for the 6 header stat numbers - uses Firestore's server-side
  // count() aggregation instead of downloading every conversation. Every
  // sub-query below is a pure equality filter (ownerUid/blocked/pinned/
  // hasReply/lastDirection/lastOutboundStatus), which Firestore can serve
  // from its automatic per-field indexes without needing a new composite
  // index - deliberately avoided any range/orderBy/"in" filter that would
  // require one, so this doesn't have any Firestore index setup step.
  //
  // "Not pinned" is computed by subtraction (raw count minus the
  // pinned-only count) rather than filtering `pinned == false` directly,
  // because most conversations have never had `pinned` set at all (it's
  // only ever written when someone manually pins/unpins) - Firestore
  // excludes documents missing a field from ANY filter on that field, so a
  // direct `pinned == false` filter would incorrectly skip every
  // never-pinned conversation. Filtering `pinned == true` doesn't have
  // this problem, since that only ever needs to match documents that do
  // have the field.
  async function loadCounts(ownerUid: string) {
    try {
      const col = collection(db, "conversations");
      const base = [where("ownerUid", "==", ownerUid), where("blocked", "==", false)];

      const count = async (...extra: ReturnType<typeof where>[]) => {
        const snap = await getCountFromServer(query(col, ...base, ...extra));
        return snap.data().count;
      };

      const [
        all,
        pinned,
        rawReplied,
        pinnedReplied,
        rawAwaiting,
        pinnedAwaiting,
        rawNeverReplied,
        pinnedNeverReplied,
        rawFailedA,
        rawFailedB,
        pinnedFailedA,
        pinnedFailedB,
      ] = await Promise.all([
        count(),
        count(where("pinned", "==", true)),
        // Not excluding pinned here - replied counts every conversation
        // with an unanswered reply regardless of pin status (see the
        // comment on `replied:` below). pinnedReplied is queried
        // separately, purely to power the "includes N pinned" hint under
        // the stat card - it's already included in rawReplied, not added
        // on top of it.
        count(where("hasReply", "==", true), where("lastDirection", "==", "inbound")),
        count(
          where("pinned", "==", true),
          where("hasReply", "==", true),
          where("lastDirection", "==", "inbound")
        ),
        count(where("hasReply", "==", true), where("lastDirection", "==", "outbound")),
        count(
          where("pinned", "==", true),
          where("hasReply", "==", true),
          where("lastDirection", "==", "outbound")
        ),
        count(where("hasReply", "==", false)),
        count(where("pinned", "==", true), where("hasReply", "==", false)),
        count(where("lastOutboundStatus", "==", "failed")),
        count(where("lastOutboundStatus", "==", "undelivered")),
        count(where("pinned", "==", true), where("lastOutboundStatus", "==", "failed")),
        count(where("pinned", "==", true), where("lastOutboundStatus", "==", "undelivered")),
      ]);

      const next: StatCounts = {
        all,
        pinned,
        // Not subtracting pinnedReplied here (unlike the other categories
        // below) - an unanswered customer reply should count toward this
        // number even if the conversation is also pinned. Pinning is a
        // quick-access shortcut, not a way to make a genuine unread reply
        // disappear from the count.
        replied: rawReplied,
        pinnedReplied,
        awaiting: Math.max(0, rawAwaiting - pinnedAwaiting),
        neverReplied: Math.max(0, rawNeverReplied - pinnedNeverReplied),
        failed: Math.max(
          0,
          rawFailedA + rawFailedB - (pinnedFailedA + pinnedFailedB)
        ),
      };

      setCounts(next);
      writePersistedCounts(ownerUid, next);
    } catch (error) {
      // Leave whatever counts are already on screen (cached or previous)
      // rather than zeroing them out - a failed refresh shouldn't make the
      // numbers disappear.
      console.error("Failed to load stat counts", error);
    }
  }

  async function loadItems(profileArg?: AppUser, opts?: { background?: boolean }) {
    const currentProfile = profileArg || profileRef.current;
    if (!currentProfile) {
      setItems([]);
      setBlockedPhones([]);
      setLoading(false);
      return;
    }

    const cacheKey = currentProfile.uid;
    const cached = getCache(cacheKey);
    const isBackground = Boolean(opts?.background);

    // Paint instantly from cache, then refresh underneath — no spinner,
    // no skeleton, no flicker for anything already seen this session (or
    // a previous one, now that the cache is also persisted to disk).
    if (cached && !isBackground) {
      setItems(filterOutBlockedRows(cached.items, cached.blocked));
      setBlockedPhones(cached.blocked);
      setLoading(false);
    } else if (!isBackground) {
      setLoading(true);
    }

    try {
      const [blacklistResult, docs] = await Promise.all([
        withTimeout(fetchBlacklist(currentProfile), NETWORK_TIMEOUT_MS, "Blacklist fetch"),
        withTimeout(fetchConversations(currentProfile), NETWORK_TIMEOUT_MS, "Conversations fetch"),
      ]);

      const { blocked, manuallyBlocked } = blacklistResult;
      const rows = buildRows(docs, blocked, manuallyBlocked);

      setCache(cacheKey, rows, blocked);

      setItems(rows);
      setBlockedPhones(blocked);
      setLoadError(false);
    } catch (error) {
      console.error("Failed to load sms activity", error);
      if (!cached) {
        setItems([]);
        setBlockedPhones([]);
        setLoadError(true);
      }
    } finally {
      setLoading(false);
    }
  }

  function togglePhoneSelection(phone: string) {
    const key = phoneKey(phone);
    setSelectedPhones((prev) =>
      prev.includes(key)
        ? prev.filter((value) => value !== key)
        : [...prev, key]
    );
  }

  function handleSelectAllVisible() {
    // "Visible" means the current page, not every match across every page
    // - matches what visibleSelectablePhones/allVisibleSelected already
    // use, and what's actually on screen to select from.
    const visiblePhones = pagedItems
      .filter((item) => !item.manuallyBlocked)
      .map((item) => phoneKey(item.phone))
      .filter(Boolean);

    setSelectedPhones((prev) => {
      const alreadyAllSelected =
        visiblePhones.length > 0 &&
        visiblePhones.every((phone) => prev.includes(phone));

      if (alreadyAllSelected) {
        return prev.filter((phone) => !visiblePhones.includes(phone));
      }

      return Array.from(new Set([...prev, ...visiblePhones]));
    });
  }

  async function handleSendFollowUp() {
    const currentUser = auth.currentUser;

    if (!currentUser) {
      alert("You are not logged in.");
      router.push("/login?next=/replies");
      return;
    }

    const recipients = filteredItems.filter((item) =>
      selectedPhones.includes(phoneKey(item.phone))
    );

    if (recipients.length === 0) {
      alert("Please select at least one customer.");
      return;
    }

    if (!followUpMessage.trim()) {
      alert("Please enter a follow-up message.");
      return;
    }

    const ok = window.confirm(
      `Send follow-up message to ${recipients.length} customer(s)?`
    );
    if (!ok) return;

    try {
      setSendingBulk(true);

      const token = await currentUser.getIdToken();

      const response = await fetch("/api/send-sms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          campaignName: "Never Replied Follow Up",
          fileId: "",
          fileName: "Replies Page",
          message: followUpMessage.trim(),
          leads: recipients.map((item) => ({
            name: item.name || "",
            phone: item.phone,
          })),
        }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || result?.ok === false) {
        throw new Error(result?.error || "Failed to send follow-up messages.");
      }

      const successCount =
        typeof result?.success === "number"
          ? result.success
          : recipients.length;

      alert(`Follow-up sent to ${successCount} customer(s).`);
      setSelectedPhones([]);
      setFollowUpMessage("");
      // The scoped live listener already picks up the change automatically
      // once the send finishes writing to each conversation doc - a full
      // fetch here would undo the whole point of scoping it. Only actually
      // needed while searching, since that path isn't live.
      if (isSearching) {
        await loadItems(undefined, { background: true });
      }
      if (profile) void loadCounts(profile.uid);
    } catch (error: any) {
      console.error("Failed to send follow-up", error);
      alert(error?.message || "Failed to send follow-up messages.");
    } finally {
      setSendingBulk(false);
    }
  }

  async function handleDeleteConversation(itemId: string) {
    const ok = window.confirm("Delete this conversation?");
    if (!ok) return;

    try {
      setDeletingId(itemId);

      const deletedItem = items.find((item) => item.id === itemId);

      await deleteDoc(doc(db, "conversations", itemId));

      if (deletedItem) {
        void logDeletion({
          type: "conversation",
          phone: deletedItem.phone,
          name: deletedItem.name,
          source: "replies_list",
        });
      }

      setItems((prev) => {
        const next = prev.filter((item) => item.id !== itemId);
        if (profileRef.current) {
          const cached = getCache(profileRef.current.uid);
          setCache(profileRef.current.uid, next, cached?.blocked || blockedPhones);
        }
        return next;
      });

      if (deletedItem) {
        setSelectedPhones((prev) =>
          prev.filter((value) => value !== phoneKey(deletedItem.phone))
        );
      }

      if (openMenuId === itemId) {
        setOpenMenuId("");
      }
    } catch (error) {
      console.error("Failed to delete conversation", error);
      alert("Failed to delete conversation.");
    } finally {
      setDeletingId("");
    }
  }

  async function handleBlockConversation(item: SmsRow) {
    if (!profile) return;

    const ok = window.confirm(
      `Block ${item.phone}? They won't be able to receive messages until you unblock them. This conversation will move to the "Attention Required" tab until you unblock it.`
    );
    if (!ok) return;

    try {
      setBlockingId(item.id);

      const numberForUser = String(
        profile.twilioNumber || profile.assignedTwilioNumber || ""
      ).trim();

      await setDoc(
        doc(db, "blacklisted_numbers", blacklistDocId(profile.uid, item.phone)),
        {
          ownerUid: profile.uid,
          ownerEmail: String(profile.email || ""),
          ownerName: String(profile.name || ""),
          phone: item.phone,
          twilioNumber: numberForUser,
          assignedTwilioNumber: String(profile.assignedTwilioNumber || ""),
          status: "blocked",
          source: "manual_block_from_replies",
          reason: "manual_block",
          lastKeyword: "STOP",
          lastBody: item.body || "",
          blockedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          unblockedAt: null,
        },
        { merge: true }
      );

      await setDoc(
        doc(db, "conversations", item.id),
        {
          status: "blocked",
          // FIX: this never set `blocked` on the conversation doc itself -
          // only `status`. The header stat counts filter on `blocked`
          // directly, so a manually-blocked number kept counting as
          // "Customer Replied" (or whichever tab it was in) forever, even
          // though the list correctly hid it via the live blacklist
          // cross-check. That's exactly the count/list mismatch found on
          // Abe's account (+17012700190).
          blocked: true,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // Manual blocks stay IN the list (marked, not removed) - only a real
      // STOP/opt-out gets fully hidden. So this updates the row in place
      // instead of filtering it out, and doesn't touch `blockedPhones`
      // (that list is reserved for numbers that should disappear entirely).
      setItems((prev) => {
        const next = prev.map((row) =>
          row.id === item.id ? { ...row, manuallyBlocked: true } : row
        );
        if (profileRef.current) {
          const cached = getCache(profileRef.current.uid);
          setCache(profileRef.current.uid, next, cached?.blocked || blockedPhones);
        }
        return next;
      });
      setSelectedPhones((prev) =>
        prev.filter((value) => value !== phoneKey(item.phone))
      );
      setOpenMenuId("");
      // The stat cards up top are a one-time fetch, not a live listener -
      // without this, blocking/unblocking correctly updates the row you're
      // looking at instantly (that part IS live), but the header numbers
      // stay stale until a manual Refresh click or a full page reload.
      void loadCounts(profile.uid);
    } catch (error) {
      console.error("Failed to block conversation", error);
      alert("Failed to block number.");
    } finally {
      setBlockingId("");
    }
  }

  async function handleUnblockConversation(item: SmsRow) {
    if (!profile) return;

    const ok = window.confirm(
      `Unblock ${item.phone}? You'll be able to message them again.`
    );
    if (!ok) return;

    try {
      setBlockingId(item.id);

      await setDoc(
        doc(db, "blacklisted_numbers", blacklistDocId(profile.uid, item.phone)),
        {
          status: "active",
          reason: "manual_unblock",
          unblockedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await setDoc(
        doc(db, "conversations", item.id),
        {
          status: "active",
          blocked: false,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setItems((prev) => {
        const next = prev.map((row) =>
          row.id === item.id ? { ...row, manuallyBlocked: false } : row
        );
        if (profileRef.current) {
          const cached = getCache(profileRef.current.uid);
          setCache(profileRef.current.uid, next, cached?.blocked || blockedPhones);
        }
        return next;
      });
      setOpenMenuId("");
      void loadCounts(profile.uid);
    } catch (error) {
      console.error("Failed to unblock conversation", error);
      alert("Failed to unblock number.");
    } finally {
      setBlockingId("");
    }
  }

  async function handleTogglePin(item: SmsRow) {
    try {
      setPinningId(item.id);
      const nextPinned = !item.pinned;

      await setDoc(
        doc(db, "conversations", item.id),
        {
          pinned: nextPinned,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setItems((prev) => {
        const next = prev.map((row) =>
          row.id === item.id ? { ...row, pinned: nextPinned } : row
        );
        if (profileRef.current) {
          const cached = getCache(profileRef.current.uid);
          setCache(profileRef.current.uid, next, cached?.blocked || blockedPhones);
        }
        return next;
      });

      setOpenMenuId("");
      // Missing here before: every sibling handler (unblock, delete, bulk
      // follow-up) calls loadCounts() right after its write so the stat
      // cards refresh immediately. This one didn't, so the row would move
      // tabs instantly (optimistic local state) while the Pinned/Customer
      // Replied numbers at the top stayed stale until something unrelated
      // happened to trigger a recount - exactly the "counts don't match
      // what's in the list" symptom seen after pinning/unpinning.
      if (profileRef.current) void loadCounts(profileRef.current.uid);
    } catch (error) {
      console.error("Failed to toggle pin", error);
      alert("Failed to update pin status.");
    } finally {
      setPinningId("");
    }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        await signOut(auth).catch(() => {});
        router.push("/login?next=/replies");
        return;
      }

      try {
        const userSnap = await withTimeout(
          getDoc(doc(db, "users", user.uid)),
          NETWORK_TIMEOUT_MS,
          "Account check"
        );

        if (!userSnap.exists() || userSnap.data().isActive !== true) {
          await signOut(auth).catch(() => {});
          router.push("/login?next=/replies");
          return;
        }

        const userData = userSnap.data() as Record<string, any>;

        // Superadmin has no conversations of its own - if it lands here
        // (stale session, direct URL, bookmark), send it to its own
        // cross-account dashboard instead of an empty/irrelevant inbox.
        if (String(userData.role || "").toLowerCase() === "superadmin") {
          router.push("/admin");
          return;
        }

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

        profileRef.current = safeProfile;
        setProfile(safeProfile);
        setChecking(false);
        setAuthTimedOut(false);

        // Fire-and-forget: fast count queries for the header stats, kicked
        // off in parallel with everything else below rather than awaited,
        // so a slow count never delays the rest of the page.
        void loadCounts(safeProfile.uid);

        // Paint from cache immediately if we have it (instant, no loading
        // state at all). The live-listener effect below (keyed on
        // `profile`) takes over from here — it fetches fresh data and,
        // unlike the old one-shot fetch, keeps listening so new inbound
        // replies and sends show up automatically without needing the
        // Refresh button. If the cache belongs to a different account
        // than the one that just signed in, drop it instead of flashing
        // someone else's data.
        const cached = getCache(safeProfile.uid);
        if (cached) {
          setItems(filterOutBlockedRows(cached.items, cached.blocked));
          setBlockedPhones(cached.blocked);
          setLoading(false);
        } else {
          setItems([]);
          setBlockedPhones([]);
        }
      } catch (error: any) {
        console.error("Failed to validate user access", error);

        const timedOut = String(error?.message || "").includes("timed out");
        const cachedFallback = getCache(user.uid);

        if (timedOut && cachedFallback) {
          // Slow network, but we already have something to show for this
          // exact account - trust the cache and stop blocking the UI on
          // it instead of kicking the person back to the login screen.
          setItems(filterOutBlockedRows(cachedFallback.items, cachedFallback.blocked));
          setBlockedPhones(cachedFallback.blocked);
          setChecking(false);
          setLoading(false);
          return;
        }

        if (timedOut) {
          // Slow/dead network and nothing to fall back on - let the
          // person retry instead of hanging on a spinner forever.
          setAuthTimedOut(true);
          setChecking(false);
          return;
        }

        await signOut(auth).catch(() => {});
        router.push("/login?next=/replies");
      }
    });

    return () => unsub();
  }, [router]);

  // Live sync: without this, the list only ever reflected whatever was
  // true at the moment of the last manual fetch, so sending a message or
  // getting a customer reply never showed up until someone clicked
  // Refresh. Firestore's onSnapshot keeps both the conversations and
  // blacklist data current in real time — same pattern already used on
  // the individual thread page and the blacklisted-numbers page — so
  // this page now updates itself the instant the underlying documents
  // change, including from actions that happen outside this browser tab
  // entirely (the inbound webhook writing a customer's reply).
  //
  // What changed: this used to always listen to EVERY conversation the
  // account has ever had, no matter which tab was open — meaning a single
  // account with tens of thousands of conversations had to have all of
  // them downloaded and kept live-synced just to show a couple of rows.
  // Now, as long as nobody's actively searching, it only listens to a
  // small, tab-scoped batch (most recent first, capped at `listLimit`) —
  // the exact same shape of fix already applied to the header counts and
  // the dashboard/blacklisted lists. Typing into the search box falls
  // back to the old "watch everything" query so full-history search still
  // works exactly as it did before.
  useEffect(() => {
    if (!profile) return;
    const ownerUid = profile.uid;

    let latestDocs: Array<{ id: string; data: Record<string, any> }> = [];
    let latestBlocked: string[] = [];
    let latestManuallyBlocked: string[] = [];
    let gotConversations = false;
    let gotBlacklist = false;

    function recompute() {
      if (!gotConversations || !gotBlacklist) return;

      const rows = buildRows(latestDocs, latestBlocked, latestManuallyBlocked);
      setItems(rows);
      setBlockedPhones(latestBlocked);
      setCache(ownerUid, rows, latestBlocked);
      setLoading(false);
      setLoadError(false);
    }

    const conversationsQuery =
      isSearching || !SCOPED_LIST_ENABLED
        ? query(collection(db, "conversations"), where("ownerUid", "==", ownerUid))
        : buildScopedConversationsQuery(ownerUid, filterMode, listLimit);

    const unsubConversations = onSnapshot(
      conversationsQuery,
      (snap) => {
        latestDocs = snap.docs.map((d) => ({
          id: d.id,
          data: d.data() as Record<string, any>,
        }));
        gotConversations = true;
        recompute();
      },
      (error) => {
        console.error("Live conversations listener failed", error);
        setLoading(false);
        if (!getCache(profile.uid)) setLoadError(true);
      }
    );

    const unsubBlacklist = onSnapshot(
      query(collection(db, "blacklisted_numbers"), where("ownerUid", "==", profile.uid)),
      (snap) => {
        const blocked: string[] = [];
        const manuallyBlocked: string[] = [];

        snap.docs.forEach((d) => {
          const data = d.data();
          if (String(data.status || "").toLowerCase() !== "blocked") return;
          const phone = String(data.phone || "").trim();
          if (!phone) return;
          if (isManualBlockRecord(data)) {
            manuallyBlocked.push(phone);
          } else {
            blocked.push(phone);
          }
        });

        latestBlocked = blocked;
        latestManuallyBlocked = manuallyBlocked;
        gotBlacklist = true;
        recompute();
      },
      (error) => {
        console.error("Live blacklist listener failed", error);
      }
    );

    return () => {
      unsubConversations();
      unsubBlacklist();
    };
  }, [profile, filterMode, listLimit, isSearching]);

  // Dedicated live source for the "Attention Required" tab - independent
  // of the scoped per-tab listener above, which now excludes every
  // manually-blocked conversation (blocked==true) from its results. The
  // number of manual blocks per account is small (a handful at most, per
  // tools/audit scripts run earlier), so this does a small, targeted set
  // of single-document lookups by conversation ID rather than downloading
  // any collection - same approach as useManuallyBlockedAttention.ts,
  // extended here to build full rows instead of just a boolean.
  useEffect(() => {
    if (!profile) return;
    const ownerUid = profile.uid;
    let cancelled = false;

    const unsubBlacklist = onSnapshot(
      query(
        collection(db, "blacklisted_numbers"),
        where("ownerUid", "==", ownerUid),
        where("status", "==", "blocked")
      ),
      async (snap) => {
        try {
          const phones = snap.docs
            .filter((d) => isManualBlockRecord(d.data() || {}))
            .map((d) => String(d.data()?.phone || "").trim())
            .filter(Boolean);

          if (phones.length === 0) {
            if (!cancelled) setAttentionItems([]);
            return;
          }

          // allSettled, not all - one phone whose conversation was deleted
          // separately (blacklist entry deliberately kept) throws
          // permission-denied on that single getDoc and must not wipe out
          // every other valid result in the same batch. Same fix as the
          // sidebar attention-mark bug earlier this session.
          const results = await Promise.allSettled(
            phones.map(async (phone) => {
              const conversationId = `${ownerUid}_${phoneDocId(phone)}`;
              const convoSnap = await getDoc(
                doc(db, "conversations", conversationId)
              );
              if (!convoSnap.exists()) return null;
              const row = makeRow(convoSnap.id, convoSnap.data() as Record<string, any>);
              return { ...row, manuallyBlocked: true };
            })
          );

          const rows = results
            .filter(
              (r): r is PromiseFulfilledResult<SmsRow | null> =>
                r.status === "fulfilled" && r.value !== null
            )
            .map((r) => r.value as SmsRow)
            .sort((a, b) => b.sortSeconds - a.sortSeconds);

          if (!cancelled) setAttentionItems(rows);
        } catch (error) {
          console.error("Failed to load Attention Required conversations", error);
          if (!cancelled) setAttentionItems([]);
        }
      },
      (error) => {
        console.error("Attention Required listener failed", error);
        if (!cancelled) setAttentionItems([]);
      }
    );

    return () => {
      cancelled = true;
      unsubBlacklist();
    };
  }, [profile]);

  // Follow-Ups tab - dedicated live source, same two-listener/recompute
  // shape as the main conversations effect further down: one listener on
  // `followUps` (status=="pending", this owner), one on `blacklisted_numbers`
  // (status=="blocked", this owner, ANY reason - STOP, abuse, or manual -
  // since the cron skips a blocked number regardless of why it's blocked).
  // No orderBy in either query (sorted client-side instead) so this doesn't
  // need a new Firestore composite index deployed.
  useEffect(() => {
    if (!profile) return;
    const ownerUid = profile.uid;

    let latestFollowUps: Array<{ id: string; data: Record<string, any> }> = [];
    let latestBlockedPhones: string[] = [];
    let gotFollowUps = false;
    let gotBlacklist = false;

    function recompute() {
      if (!gotFollowUps || !gotBlacklist) return;

      const blockedSet = new Set(
        latestBlockedPhones.map((phone) => phoneKey(phone))
      );

      let skipped = 0;
      const rows: FollowUpRow[] = [];

      latestFollowUps.forEach(({ id, data }) => {
        const phone = String(data.phone || "").trim();
        if (!phone) return;

        if (blockedSet.has(phoneKey(phone))) {
          skipped++;
          return;
        }

        const dueAt = data.dueAt;
        const dueAtMs =
          typeof dueAt?.toDate === "function"
            ? dueAt.toDate().getTime()
            : typeof dueAt?.seconds === "number"
            ? dueAt.seconds * 1000
            : 0;

        rows.push({
          id,
          phone,
          message: String(data.followUpMessage || ""),
          campaignName: String(data.campaignName || ""),
          dueAtMs,
          delayHours: Number(data.delayHours || 0),
        });
      });

      rows.sort((a, b) => a.dueAtMs - b.dueAtMs);

      setFollowUpItems(rows);
      setFollowUpsSkippedCount(skipped);
    }

    const unsubFollowUps = onSnapshot(
      query(
        collection(db, "followUps"),
        where("ownerUid", "==", ownerUid),
        where("status", "==", "pending")
      ),
      (snap) => {
        latestFollowUps = snap.docs.map((d) => ({
          id: d.id,
          data: d.data() as Record<string, any>,
        }));
        gotFollowUps = true;
        recompute();
      },
      (error) => {
        console.error("Follow-Ups listener failed", error);
        setFollowUpItems([]);
        setFollowUpsSkippedCount(0);
      }
    );

    const unsubBlacklistForFollowUps = onSnapshot(
      query(
        collection(db, "blacklisted_numbers"),
        where("ownerUid", "==", ownerUid),
        where("status", "==", "blocked")
      ),
      (snap) => {
        latestBlockedPhones = snap.docs
          .map((d) => String(d.data()?.phone || "").trim())
          .filter(Boolean);
        gotBlacklist = true;
        recompute();
      },
      (error) => {
        console.error("Follow-Ups blacklist listener failed", error);
      }
    );

    return () => {
      unsubFollowUps();
      unsubBlacklistForFollowUps();
    };
  }, [profile]);

  useEffect(() => {
    function handleGlobalClick() {
      setOpenMenuId("");
    }

    if (openMenuId) {
      window.addEventListener("click", handleGlobalClick);
    }

    return () => {
      window.removeEventListener("click", handleGlobalClick);
    };
  }, [openMenuId]);

  useEffect(() => {
    setListLimit(DEFAULT_LIST_LIMIT);
  }, [filterMode]);

  useEffect(() => {
    setPage(1);
  }, [filterMode, search]);

  useEffect(() => {
    if (filterMode !== "never_replied") {
      setSelectedPhones([]);
      setFollowUpMessage("");
    }
  }, [filterMode]);

  const searchedItems = useMemo(() => {
    const source = filterMode === "attention" ? attentionItems : items;
    const term = search.trim().toLowerCase();
    if (!term) return source;

    return source.filter((item) => {
      return (
        item.phone.toLowerCase().includes(term) ||
        String(item.name || "").toLowerCase().includes(term) ||
        item.body.toLowerCase().includes(term)
      );
    });
  }, [items, attentionItems, filterMode, search]);

  const filteredItems = useMemo(() => {
    // Attention Required is already its own dedicated, pre-filtered source
    // (manual blocks only, via the effect above) - no pinned/reply-status
    // re-filtering applies here, unlike every other tab.
    if (filterMode === "attention") {
      return searchedItems;
    }

    if (filterMode === "pinned") {
      return searchedItems.filter((item) => item.pinned);
    }

    const nonPinned = searchedItems.filter((item) => !item.pinned);

    // A pinned conversation only ever shows under "Pinned Messages", never
    // duplicated here too - but it still counts toward the Customer
    // Replied number/badge/notification (see loadCounts and
    // useRepliedCount) even while it's excluded from this list.
    if (filterMode === "replied") {
      return nonPinned.filter(
        (item) => item.hasReply && item.lastDirection === "inbound"
      );
    }

    if (filterMode === "awaiting") {
      return nonPinned.filter(
        (item) => item.hasReply && item.lastDirection === "outbound"
      );
    }

    if (filterMode === "never_replied") {
      return nonPinned.filter((item) => !item.hasReply);
    }

    if (filterMode === "failed") {
      return nonPinned.filter((item) =>
        isFailedOutboundStatus(item.lastOutboundStatus)
      );
    }

    return nonPinned;
  }, [searchedItems, filterMode]);

  const repliesTotalPages = Math.max(
    1,
    Math.ceil(filteredItems.length / REPLIES_PAGE_SIZE)
  );

  // Clamps back down if the list shrinks (unblocking/deleting a
  // conversation, etc.) and the current page number would otherwise point
  // past the end.
  useEffect(() => {
    setPage((prev) => (prev > repliesTotalPages ? repliesTotalPages : prev));
  }, [repliesTotalPages]);

  const pagedItems = useMemo(() => {
    const start = (page - 1) * REPLIES_PAGE_SIZE;
    return filteredItems.slice(start, start + REPLIES_PAGE_SIZE);
  }, [filteredItems, page]);

  const visibleSelectablePhones = useMemo(() => {
    if (filterMode !== "never_replied") return [];
    return pagedItems
      .filter((item) => !item.manuallyBlocked)
      .map((item) => phoneKey(item.phone))
      .filter(Boolean);
  }, [pagedItems, filterMode]);

  const allVisibleSelected =
    visibleSelectablePhones.length > 0 &&
    visibleSelectablePhones.every((phone) => selectedPhones.includes(phone));

  const selectedVisibleCount = visibleSelectablePhones.filter((phone) =>
    selectedPhones.includes(phone)
  ).length;

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

  if (authTimedOut) {
    return (
      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <section style={panelStyle}>
            <div style={emptyStateStyle}>
              <div style={emptyTitleStyle}>Connection is slower than usual.</div>
              <div style={emptyTextStyle}>
                We couldn&apos;t verify your account in time. Check your
                connection and try again.
              </div>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={refreshButtonStyle}
              >
                Retry
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <>
      <style jsx global>{`
        input::placeholder {
          color: rgba(236, 254, 255, 0.72);
        }
      `}</style>

      {showMobileQr ? (
        <div
          style={mobileQrBackdropStyle}
          onClick={() => setShowMobileQr(false)}
        >
          <div
            style={mobileQrModalStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowMobileQr(false)}
              style={mobileQrCloseButtonStyle}
              aria-label="Close"
            >
              ✕
            </button>
            <img src="/logo-mark.png" alt="" aria-hidden="true" style={mobileQrLogoStyle} />
            <div style={mobileQrTitleStyle}>Scan to open on your phone</div>
            <div style={mobileQrTextStyle}>
              Opens straight to sign-in, then Replies - add it to your home
              screen for the full app experience.
            </div>
            {siteOrigin ? (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(
                  `${siteOrigin}/login?next=/replies`
                )}`}
                alt="QR code to open Replies on your phone"
                width={200}
                height={200}
                style={mobileQrImageStyle}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <div style={heroStyle}>
            <div style={heroOverlayStyle} />
            <div style={heroInnerStyle}>
              {isMobile ? (
                <>
                  <div style={mobileBrandRowStyle}>
                    <img src="/logo-mark.png" alt="" aria-hidden="true" style={mobileBrandLogoStyle} />
                    <div>
                      <div style={mobileBrandTitleStyle}>Nexgen Replies</div>
                      <div style={mobileBrandSubStyle}>
                        {filterModeLabel(filterMode)}
                      </div>
                    </div>
                  </div>

                </>
              ) : (
                <div>
                  <div style={heroBadgeStyle}>SMS Activity</div>
                  <h1 style={heroTitleStyle}>All Sent SMS</h1>
                  <p style={heroTextStyle}>
                    This page shows only new customer conversations owned by the
                    logged-in user. STOP and blacklisted numbers are hidden.
                  </p>
                </div>
              )}

              {/* Mobile (installed home-screen app) only - the "Allow"
                  permission prompt is meant for the phone-app experience;
                  desktop staff aren't expected to install/enable push here. */}
              {isMobile &&
              notifPermission !== "granted" &&
              notifPermission !== "unsupported" ? (
                <button
                  type="button"
                  onClick={() => void handleEnableNotifications()}
                  disabled={enablingNotifs}
                  style={enableNotifsBannerStyle}
                >
                  {enablingNotifs
                    ? "Enabling..."
                    : notifPermission === "denied"
                      ? "Notifications blocked - enable in Settings"
                      : "🔔 Enable notifications for new replies"}
                </button>
              ) : null}

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

                {isMobile ? null : (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowMobileQr(true)}
                      style={switchToMobileButtonStyle}
                    >
                      Switch to Mobile
                    </button>
                    <Link href="/dashboard" style={backButtonStyle}>
                      Back to Dashboard
                    </Link>
                  </>
                )}
              </div>

              <div
                style={
                  isMobile
                    ? {
                        ...filterTabsStyle,
                        flexWrap: "nowrap",
                        overflowX: "auto",
                        WebkitOverflowScrolling: "touch",
                        margin: "0 -20px",
                        padding: "0 20px",
                      }
                    : filterTabsStyle
                }
              >
                <button
                  onClick={() => setFilterMode("all")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "all" ? activeFilterTabStyle : {}),
                  }}
                >
                  All
                </button>

                <button
                  onClick={() => setFilterMode("replied")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "replied" ? activeFilterTabStyle : {}),
                  }}
                >
                  Customer Replied
                </button>

                <button
                  onClick={() => setFilterMode("awaiting")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "awaiting" ? activeFilterTabStyle : {}),
                  }}
                >
                  Waiting for Customer
                </button>

                <button
                  onClick={() => setFilterMode("never_replied")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "never_replied"
                      ? activeFilterTabStyle
                      : {}),
                  }}
                >
                  Never Replied
                </button>

                <button
                  onClick={() => setFilterMode("pinned")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "pinned" ? activeFilterTabStyle : {}),
                  }}
                >
                  📌 Pinned Messages
                </button>

                <button
                  onClick={() => setFilterMode("failed")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "failed" ? activeFilterTabStyle : {}),
                  }}
                >
                  ⚠ Failed / Undelivered
                </button>

                <button
                  onClick={() => setFilterMode("attention")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "attention" ? activeFilterTabStyle : {}),
                  }}
                >
                  ❗ Attention Required
                </button>

                <button
                  onClick={() => setFilterMode("followups")}
                  style={{
                    ...filterTabStyle,
                    ...(filterMode === "followups" ? activeFilterTabStyle : {}),
                  }}
                >
                  ⏱ Follow-Ups
                </button>
              </div>

              {isMobile ? (
                // Full 7-card grid is a desktop-dashboard pattern - crammed
                // onto a phone it either wraps into a messy multi-row grid
                // or squeezes numbers down until they clip (both of which
                // happened). Showing just the active tab's own count reads
                // clearly at a glance and always matches what's actually
                // listed below, since it's computed the same way.
                <div>
                  <div style={mobileStatLineStyle}>
                    <span style={mobileStatNumberStyle}>
                      {activeTabCount(
                        filterMode,
                        counts,
                        attentionItems.length,
                        followUpItems.length
                      )}
                    </span>
                    <span style={mobileStatLabelStyle}>
                      {filterModeLabel(filterMode).toLowerCase()}
                    </span>
                  </div>
                  {filterMode === "replied" && counts.pinnedReplied > 0 ? (
                    <div style={mobileStatHintStyle}>
                      Includes {counts.pinnedReplied} pinned
                    </div>
                  ) : null}
                  {filterMode === "followups" && followUpsSkippedCount > 0 ? (
                    <div style={mobileStatHintStyle}>
                      {followUpsSkippedCount} blocked - won&apos;t send
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style={statsGridStyle}>
                  <StatCard label="All Sent SMS" value={String(counts.all)} />
                  <StatCard
                    label="Customer Replied"
                    value={String(counts.replied)}
                    hint={
                      counts.pinnedReplied > 0
                        ? `Includes ${counts.pinnedReplied} pinned`
                        : undefined
                    }
                  />
                  <StatCard
                    label="Waiting for Customer"
                    value={String(counts.awaiting)}
                  />
                  <StatCard
                    label="Never Replied"
                    value={String(counts.neverReplied)}
                  />
                  <StatCard label="Pinned" value={String(counts.pinned)} />
                  <StatCard label="Failed / Undelivered" value={String(counts.failed)} />
                  <StatCard
                    label="Attention Required"
                    value={String(attentionItems.length)}
                  />
                  <StatCard
                    label="Follow-Ups Pending"
                    value={String(followUpItems.length)}
                    hint={
                      followUpsSkippedCount > 0
                        ? `${followUpsSkippedCount} blocked - won't send`
                        : undefined
                    }
                  />
                </div>
              )}
            </div>
          </div>

          <section style={panelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <h2 style={panelTitleStyle}>
                  {filterMode === "pinned"
                    ? "Pinned Messages"
                    : filterMode === "failed"
                    ? "Failed / Undelivered Messages"
                    : filterMode === "attention"
                    ? "Attention Required"
                    : filterMode === "followups"
                    ? "Upcoming Follow-Ups"
                    : "Outbound SMS Activity"}
                </h2>
                <p style={panelDescStyle}>
                  {filterMode === "pinned"
                    ? "Conversations you've pinned for quick access. Unpin to send them back to their normal tab."
                    : filterMode === "failed"
                    ? "Conversations whose most recent outbound message failed to deliver or was reported undelivered by the carrier."
                    : filterMode === "attention"
                    ? "Numbers your team manually blocked. Unblock to resume messaging - a customer's own STOP opt-out is never shown here, those stay fully hidden."
                    : filterMode === "followups"
                    ? "Follow-up messages queued from a campaign's follow-up setting, with the time remaining until each one sends. Numbers that have since been blocked are left out - they'll never actually go out."
                    : "Only new conversations with `ownerUid` matching the logged-in user are shown for non-admin accounts."}
                </p>
              </div>

              <button
                onClick={() => {
                  // While searching, the list comes from a one-time full
                  // fetch (not a live listener), so Refresh needs to
                  // re-run it. Otherwise the scoped query above is already
                  // live - nothing to re-fetch, just nudge the counts.
                  if (isSearching) {
                    loadItems(undefined, { background: true });
                  }
                  if (profile) void loadCounts(profile.uid);
                }}
                style={refreshButtonStyle}
              >
                Refresh
              </button>
            </div>

            {filterMode === "never_replied" ? (
              <div style={bulkFollowUpPanelStyle}>
                <div style={bulkFollowUpHeaderStyle}>
                  <div>
                    <h3 style={bulkFollowUpTitleStyle}>
                      Follow up with customers who never replied
                    </h3>
                    <p style={bulkFollowUpTextStyle}>
                      Select customers who did not reply at all and send one
                      follow-up message.
                    </p>
                  </div>

                  <label style={selectAllWrapStyle}>
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={handleSelectAllVisible}
                    />
                    <span>Select all visible customers</span>
                  </label>
                </div>

                <div style={bulkFollowUpMetaStyle}>
                  {selectedVisibleCount} selected
                </div>

                <textarea
                  value={followUpMessage}
                  onChange={(e) => setFollowUpMessage(e.target.value)}
                  placeholder="Write your follow-up message here..."
                  style={followUpTextareaStyle}
                />

                <div style={bulkFollowUpActionsStyle}>
                  <button
                    type="button"
                    onClick={handleSendFollowUp}
                    disabled={
                      sendingBulk ||
                      selectedVisibleCount === 0 ||
                      !followUpMessage.trim()
                    }
                    style={{
                      ...sendFollowUpButtonStyle,
                      opacity:
                        sendingBulk ||
                        selectedVisibleCount === 0 ||
                        !followUpMessage.trim()
                          ? 0.6
                          : 1,
                      cursor:
                        sendingBulk ||
                        selectedVisibleCount === 0 ||
                        !followUpMessage.trim()
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {sendingBulk
                      ? "Sending..."
                      : `Send follow-up to ${selectedVisibleCount || 0} customer(s)`}
                  </button>
                </div>
              </div>
            ) : null}

            {filterMode === "followups" ? (
              followUpItems.length === 0 ? (
                <div style={emptyStateStyle}>
                  <div style={emptyDotStyle} />
                  <div style={emptyTitleStyle}>No follow-ups scheduled.</div>
                  <div style={emptyTextStyle}>
                    {followUpsSkippedCount > 0
                      ? `${followUpsSkippedCount} follow-up(s) exist but are excluded here since those numbers are already blocked and won't be sent.`
                      : "Turn on \"Send an automated follow-up message\" from the SMS Portal to queue one."}
                  </div>
                </div>
              ) : (
                <div style={followUpListStyle}>
                  {followUpItems.map((item) => (
                    <FollowUpCard key={item.id} item={item} nowMs={nowMs} />
                  ))}
                </div>
              )
            ) : loading ? (
              <div style={simpleLoadingStyle}>
                <span style={listLoadingDotStyle} />
                <span>Loading SMS activity...</span>
              </div>
            ) : loadError ? (
              <div style={emptyStateStyle}>
                <div style={emptyDotStyle} />
                <div style={emptyTitleStyle}>Couldn&apos;t load SMS activity.</div>
                <div style={emptyTextStyle}>
                  That took too long or failed. Check your connection and try
                  again.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    loadItems(undefined, { background: true });
                    if (profile) void loadCounts(profile.uid);
                  }}
                  style={refreshButtonStyle}
                >
                  Retry
                </button>
              </div>
            ) : filteredItems.length === 0 ? (
              <div style={emptyStateStyle}>
                <div style={emptyDotStyle} />
                <div style={emptyTitleStyle}>
                  {filterMode === "pinned"
                    ? "No pinned messages yet."
                    : filterMode === "failed"
                    ? "No failed or undelivered messages."
                    : "No SMS found for this filter."}
                </div>
                <div style={emptyTextStyle}>
                  {filterMode === "pinned"
                    ? "Pin a conversation from the ⋯ menu to see it here."
                    : filterMode === "failed"
                    ? "Conversations will show up here if a message fails to send or the carrier reports it undelivered."
                    : "New messages and replies will appear here once they are saved with the correct ownerUid."}
                </div>
              </div>
            ) : (
              <div style={conversationGridStyle}>
                {pagedItems.map((item) => (
                  <div key={item.id} style={conversationShellStyle}>
                    {filterMode === "never_replied" && !item.manuallyBlocked ? (
                      <div style={rowCheckboxWrapStyle}>
                        <input
                          type="checkbox"
                          checked={selectedPhones.includes(phoneKey(item.phone))}
                          onChange={() => togglePhoneSelection(item.phone)}
                          onClick={(e) => e.stopPropagation()}
                          style={rowCheckboxStyle}
                        />
                      </div>
                    ) : null}

                    <Link
                      href={`/replies/${encodeURIComponent(item.phone)}`}
                      style={{
                        ...conversationCardStyle,
                        paddingLeft: filterMode === "never_replied" ? 64 : 20,
                        ...(item.manuallyBlocked ? manuallyBlockedCardStyle : null),
                      }}
                    >
                      <div style={conversationTopStyle}>
                        <div>
                          <div style={phoneStyle}>
                            {item.manuallyBlocked ? (
                              <span style={attentionMarkStyle} title="Blocked - needs attention">
                                ⚠️
                              </span>
                            ) : null}
                            {item.pinned ? "📌 " : ""}
                            {item.phone}
                          </div>
                          {item.name ? (
                            <div style={nameStyle}>{item.name}</div>
                          ) : null}
                          {isMobile ? (
                            <div style={timeStyleMobile}>{item.createdAtLabel}</div>
                          ) : null}
                        </div>

                        <div style={conversationRightStyle}>
                          {isMobile ? null : (
                            <div style={timeStyle}>{item.createdAtLabel}</div>
                          )}
                          <div
                            style={
                              // Manually blocked always wins, regardless of
                              // reply/delivery state - it's a deliberate
                              // staff decision, not a delivery/reply signal.
                              item.manuallyBlocked
                                ? manuallyBlockedBadgeStyle
                                : isFailedOutboundStatus(item.lastOutboundStatus) &&
                                  item.lastDirection !== "inbound"
                                ? failedBadgeStyle
                                : item.hasReply && item.lastDirection === "inbound"
                                ? repliedBadgeStyle
                                : awaitingReplyBadgeStyle
                            }
                          >
                            {item.manuallyBlocked
                              ? "Blocked — Unblock to continue chat"
                              : isFailedOutboundStatus(item.lastOutboundStatus) &&
                                item.lastDirection !== "inbound"
                              ? "Delivery Issue"
                              : item.hasReply && item.lastDirection === "inbound"
                              ? "Customer Replied"
                              : item.hasReply && item.lastDirection === "outbound"
                                ? "Waiting for Customer"
                                : "Never Replied"}
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

                    <div style={actionWrapStyle}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOpenMenuId((prev) =>
                            prev === item.id ? "" : item.id
                          );
                        }}
                        style={actionButtonStyle}
                      >
                        ⋯
                      </button>

                      {openMenuId === item.id ? (
                        <div
                          style={actionMenuStyle}
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId("");
                              router.push(
                                `/replies/${encodeURIComponent(item.phone)}`
                              );
                            }}
                            style={menuItemStyle}
                          >
                            Open
                          </button>

                          <button
                            type="button"
                            onClick={() => handleTogglePin(item)}
                            disabled={pinningId === item.id}
                            style={{
                              ...menuItemStyle,
                              color: "#0d9488",
                              background: "rgba(13,148,136,0.08)",
                              opacity: pinningId === item.id ? 0.6 : 1,
                            }}
                          >
                            {pinningId === item.id
                              ? "Updating..."
                              : item.pinned
                                ? "Unpin"
                                : "Pin"}
                          </button>

                          {item.manuallyBlocked ? (
                            <button
                              type="button"
                              onClick={() => handleUnblockConversation(item)}
                              disabled={blockingId === item.id}
                              style={{
                                ...menuItemStyle,
                                color: "#0d9488",
                                background: "rgba(13,148,136,0.08)",
                                opacity: blockingId === item.id ? 0.6 : 1,
                              }}
                            >
                              {blockingId === item.id ? "Unblocking..." : "Unblock"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleBlockConversation(item)}
                              disabled={blockingId === item.id}
                              style={{
                                ...menuItemStyle,
                                color: "#b45309",
                                background: "rgba(245,158,11,0.08)",
                                opacity: blockingId === item.id ? 0.6 : 1,
                              }}
                            >
                              {blockingId === item.id ? "Blocking..." : "Block"}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => handleDeleteConversation(item.id)}
                            disabled={deletingId === item.id}
                            style={{
                              ...menuItemStyle,
                              ...dangerMenuItemStyle,
                              opacity: deletingId === item.id ? 0.6 : 1,
                            }}
                          >
                            {deletingId === item.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {filterMode !== "followups" && filteredItems.length > REPLIES_PAGE_SIZE ? (
              <div style={repliesPaginationRowStyle}>
                <span style={repliesPaginationLabelStyle}>
                  Page {page} of {repliesTotalPages} &middot;{" "}
                  {filteredItems.length} total
                </span>

                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    style={{
                      ...repliesPaginationButtonStyle,
                      ...(page <= 1 ? repliesPaginationButtonDisabledStyle : null),
                    }}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPage((p) => Math.min(repliesTotalPages, p + 1))
                    }
                    disabled={page >= repliesTotalPages}
                    style={{
                      ...repliesPaginationButtonStyle,
                      ...(page >= repliesTotalPages
                        ? repliesPaginationButtonDisabledStyle
                        : null),
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}

            {filterMode !== "followups" &&
            SCOPED_LIST_ENABLED &&
            !isSearching &&
            !loading &&
            !loadError &&
            items.length >= listLimit ? (
              <div style={loadMoreRowStyle}>
                <button
                  type="button"
                  onClick={() => setListLimit((prev) => prev + LIST_LIMIT_STEP)}
                  style={refreshButtonStyle}
                >
                  Load more
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
      {hint ? <div style={statHintStyle}>{hint}</div> : null}
    </div>
  );
}

function FollowUpCard({ item, nowMs }: { item: FollowUpRow; nowMs: number }) {
  const countdown = formatFollowUpCountdown(item.dueAtMs, nowMs);

  return (
    <Link
      href={`/replies/${encodeURIComponent(item.phone)}`}
      style={followUpCardStyle}
    >
      <div style={followUpTopRowStyle}>
        <div style={phoneStyle}>{item.phone}</div>
        <div
          style={{
            ...followUpCountdownBadgeStyle,
            ...(countdown.overdue ? followUpCountdownOverdueStyle : null),
          }}
        >
          {countdown.label}
        </div>
      </div>

      {item.campaignName ? (
        <div style={followUpCampaignStyle}>{item.campaignName}</div>
      ) : null}

      <div style={messagePreviewStyle}>{truncateText(item.message || "-")}</div>

      {item.delayHours > 0 ? (
        <div style={followUpDelayStyle}>
          {item.delayHours} hour{item.delayHours === 1 ? "" : "s"} after send
        </div>
      ) : null}
    </Link>
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

const mobileBrandRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const mobileBrandLogoStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 11,
  objectFit: "cover",
  flexShrink: 0,
};

const mobileBrandTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 19,
  fontWeight: 800,
  lineHeight: 1.2,
};

const mobileBrandSubStyle: CSSProperties = {
  marginTop: 2,
  color: "rgba(236,254,255,0.8)",
  fontSize: 13.5,
  fontWeight: 600,
};

const enableNotifsBannerStyle: CSSProperties = {
  marginTop: 14,
  width: "100%",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 14,
  padding: "12px 14px",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontWeight: 700,
  fontSize: 13.5,
  textAlign: "center",
  cursor: "pointer",
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

const filterTabsStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const filterTabStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.22)",
  background: "rgba(255,255,255,0.10)",
  color: "#ecfeff",
  borderRadius: 999,
  padding: "10px 16px",
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  // Without this, tabs shrink to fit their flex container instead of
  // overflowing it - which is exactly what breaks the mobile horizontal
  // scroll strip (see the isMobile override on filterTabsStyle below):
  // they'd just get squeezed unreadably narrow instead of scrolling.
  // Harmless on desktop's wrapping layout either way.
  flexShrink: 0,
};

const activeFilterTabStyle: CSSProperties = {
  background: "#ecfeff",
  color: "#0f766e",
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

const switchToMobileButtonStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 18,
  padding: "15px 20px",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 15,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const mobileQrBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15,23,42,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
  padding: 20,
};

const mobileQrModalStyle: CSSProperties = {
  position: "relative",
  background: "#ffffff",
  borderRadius: 24,
  padding: "32px 28px",
  maxWidth: 340,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: 6,
  boxShadow: "0 30px 60px rgba(15,23,42,0.3)",
};

const mobileQrCloseButtonStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  border: "none",
  background: "#f1f5f9",
  color: "#0f172a",
  width: 28,
  height: 28,
  borderRadius: 999,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

const mobileQrLogoStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 12,
  objectFit: "cover",
  marginBottom: 4,
};

const mobileQrTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#0f172a",
};

const mobileQrTextStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "#64748b",
  marginBottom: 10,
};

const mobileQrImageStyle: CSSProperties = {
  borderRadius: 12,
  border: "1px solid #e2e8f0",
  padding: 8,
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: 14,
};

const mobileStatLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

const mobileStatNumberStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 28,
  fontWeight: 900,
  lineHeight: 1,
};

const mobileStatLabelStyle: CSSProperties = {
  color: "rgba(236,254,255,0.8)",
  fontSize: 14,
  fontWeight: 600,
};

const mobileStatHintStyle: CSSProperties = {
  marginTop: 2,
  color: "rgba(236, 254, 255, 0.65)",
  fontSize: 11.5,
  fontWeight: 600,
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

const statHintStyle: CSSProperties = {
  marginTop: 4,
  color: "rgba(236, 254, 255, 0.65)",
  fontSize: 11.5,
  fontWeight: 600,
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

const bulkFollowUpPanelStyle: CSSProperties = {
  marginTop: 18,
  marginBottom: 18,
  borderRadius: 22,
  padding: 20,
  background: "linear-gradient(180deg, #f0fdfa 0%, #ecfeff 100%)",
  border: "1px solid rgba(13,148,136,0.14)",
  display: "grid",
  gap: 14,
};

const bulkFollowUpHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap",
};

const bulkFollowUpTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 900,
  color: "#0f172a",
};

const bulkFollowUpTextStyle: CSSProperties = {
  margin: "6px 0 0 0",
  fontSize: 14,
  lineHeight: 1.6,
  color: "#475569",
};

const selectAllWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  fontSize: 14,
  fontWeight: 700,
  color: "#0f172a",
};

const bulkFollowUpMetaStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: "#0d9488",
};

const followUpTextareaStyle: CSSProperties = {
  width: "100%",
  minHeight: 120,
  resize: "vertical",
  borderRadius: 16,
  border: "1px solid rgba(15,23,42,0.08)",
  padding: 14,
  fontSize: 15,
  lineHeight: 1.6,
  outline: "none",
  background: "#ffffff",
  color: "#0f172a",
};

const bulkFollowUpActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
};

const sendFollowUpButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 14,
  padding: "14px 18px",
  background: "#0d9488",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 14,
};

const conversationGridStyle: CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
};

const loadMoreRowStyle: CSSProperties = {
  marginTop: 20,
  display: "flex",
  justifyContent: "center",
};

const repliesPaginationRowStyle: CSSProperties = {
  marginTop: 20,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 14,
  flexWrap: "wrap",
};

const repliesPaginationLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#64748b",
};

const repliesPaginationButtonStyle: CSSProperties = {
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 14,
  padding: "10px 18px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
};

const repliesPaginationButtonDisabledStyle: CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
};

const conversationShellStyle: CSSProperties = {
  position: "relative",
};

const rowCheckboxWrapStyle: CSSProperties = {
  position: "absolute",
  top: 24,
  left: 18,
  zIndex: 6,
};

const rowCheckboxStyle: CSSProperties = {
  width: 18,
  height: 18,
  cursor: "pointer",
};

const conversationCardStyle: CSSProperties = {
  textDecoration: "none",
  color: "#0f172a",
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15, 23, 42, 0.06)",
  borderRadius: 22,
  padding: 20,
  paddingRight: 78,
  display: "block",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.05)",
};

const manuallyBlockedCardStyle: CSSProperties = {
  background: "linear-gradient(180deg, #fef2f2 0%, #fee2e2 100%)",
  border: "1px solid rgba(220, 38, 38, 0.25)",
};

const actionWrapStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 5,
};

const actionButtonStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 12,
  border: "1px solid rgba(15,23,42,0.08)",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 22,
  fontWeight: 900,
  lineHeight: 1,
  cursor: "pointer",
  boxShadow: "0 8px 18px rgba(15,23,42,0.08)",
};

const actionMenuStyle: CSSProperties = {
  position: "absolute",
  top: 48,
  right: 0,
  minWidth: 140,
  borderRadius: 14,
  border: "1px solid rgba(15,23,42,0.08)",
  background: "#ffffff",
  boxShadow: "0 16px 34px rgba(15,23,42,0.12)",
  padding: 8,
  display: "grid",
  gap: 6,
};

const menuItemStyle: CSSProperties = {
  border: "none",
  borderRadius: 10,
  padding: "10px 12px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 14,
  fontWeight: 800,
  textAlign: "left",
  cursor: "pointer",
};

const dangerMenuItemStyle: CSSProperties = {
  color: "#b91c1c",
  background: "rgba(220,38,38,0.04)",
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

const attentionMarkStyle: CSSProperties = {
  display: "inline-block",
  marginRight: 6,
  fontSize: 21,
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

const failedBadgeStyle: CSSProperties = {
  marginTop: 8,
  display: "inline-block",
  background: "rgba(239, 68, 68, 0.14)",
  color: "#b91c1c",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  borderRadius: 999,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 800,
};

const manuallyBlockedBadgeStyle: CSSProperties = {
  marginTop: 8,
  display: "inline-block",
  background: "#dc2626",
  color: "#ffffff",
  border: "1px solid #b91c1c",
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

const followUpListStyle: CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
};

const followUpCardStyle: CSSProperties = {
  textDecoration: "none",
  color: "#0f172a",
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
  border: "1px solid rgba(15, 23, 42, 0.06)",
  borderRadius: 22,
  padding: 20,
  display: "block",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.05)",
};

const followUpTopRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const followUpCountdownBadgeStyle: CSSProperties = {
  background: "rgba(13,148,136,0.10)",
  color: "#0d9488",
  fontSize: 12.5,
  fontWeight: 800,
  padding: "6px 12px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const followUpCountdownOverdueStyle: CSSProperties = {
  background: "rgba(220,38,38,0.10)",
  color: "#dc2626",
};

const followUpCampaignStyle: CSSProperties = {
  marginTop: 8,
  color: "#0d9488",
  fontSize: 13,
  fontWeight: 700,
};

const followUpDelayStyle: CSSProperties = {
  marginTop: 10,
  color: "#94a3b8",
  fontSize: 12.5,
  fontWeight: 600,
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

// Minimal, static, one-line loading indicator — no shimmering skeleton
// cards. Thanks to the persisted cache above, this is only ever seen on
// a person's very first visit from a given browser; every return visit
// paints instantly instead.
const simpleLoadingStyle: CSSProperties = {
  marginTop: 18,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "16px 18px",
  borderRadius: 16,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  fontSize: 14,
  fontWeight: 700,
};

const listLoadingDotStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#14b8a6",
  flexShrink: 0,
};
