"use client";

import Link from "next/link";
import {
  use,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  updateDoc,
  type Query,
  type DocumentData,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { auth, db, storage } from "../../../lib/firebase";
import { formatFirestoreDateNY } from "../../../lib/date";
import { describeTwilioError } from "../../../lib/twilioErrorCodes";

type MediaMetaItem = {
  url: string;
  contentType?: string;
};

type UploadedMediaItem = {
  url: string;
  contentType: string;
  name: string;
};

type MessageItem = {
  id: string;
  sid?: string;
  from?: string;
  to?: string;
  body?: string;
  direction?: string;
  status?: string;
  read?: boolean;
  mediaUrls?: string[];
  mediaMeta?: MediaMetaItem[];
  numMedia?: number;
  error?: string;
  errorCode?: string;
  createdAtLabel: string;
  createdAtMs: number;
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

type ConversationMeta = {
  id: string;
  phone: string;
  name?: string;
  status?: string;
  hasReply?: boolean;
  unreadCount?: number;
  lastDirection?: string;
  twilioNumber?: string;
  assignedTwilioNumber?: string;
  messagingServiceSid?: string;
  ownerUid?: string;
  lastMessage?: string;
  lastMessageAt?: any;
  updatedAt?: any;
  pinned?: boolean;
  // True for both a manual Block and a customer's own STOP opt-out - this
  // is the same field the send-reply/send-sms API routes check server-side
  // before allowing a send, so the button here just mirrors what would
  // happen anyway instead of letting someone try and hit an error.
  blocked?: boolean;
};

// Module-level cache: instant repaint of a thread already opened this
// session, while a fresh fetch (and the live onSnapshot listener) keeps
// it correct underneath. Keyed by `${uid}_${normalizedPhone}`.
const threadCache = new Map<
  string,
  { meta: ConversationMeta; messages: MessageItem[]; ts: number }
>();

// Anything cached longer ago than this is treated as too stale to paint
// instantly — better to show the (plain) loading state than flash old data.
const CACHE_FRESHNESS_MS = 20_000;

function buildCacheKey(uid: string, phone: string) {
  return `${uid}_${normalizePhone(phone)}`;
}

function getFreshCacheEntry(uid: string | undefined, phone: string) {
  if (!uid) return undefined;
  const entry = threadCache.get(buildCacheKey(uid, phone));
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= CACHE_FRESHNESS_MS) return undefined;
  return entry;
}

function normalizePhone(value: string) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function phoneDocId(phone: string) {
  return normalizePhone(phone);
}

function toMillis(value: any) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value?.seconds && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  return 0;
}

function safeString(value: any) {
  return String(value || "").trim();
}

function isFailedMessageStatus(status?: string) {
  const value = safeString(status).toLowerCase();
  return value === "failed" || value === "undelivered";
}

function normalizeMediaUrls(value: any) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeString(item)).filter(Boolean);
}

function normalizeMediaMeta(value: any): MediaMetaItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => ({
      url: safeString(item?.url || item?.mediaUrl || ""),
      contentType: safeString(item?.contentType || item?.type || ""),
    }))
    .filter((item) => item.url);
}

function getMediaKind(url: string, contentType?: string) {
  const type = safeString(contentType).toLowerCase();
  const lowerUrl = safeString(url).toLowerCase();

  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";

  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|$)/i.test(lowerUrl)) return "image";
  if (/\.(mp4|mov|webm|m4v|avi)(\?|$)/i.test(lowerUrl)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac)(\?|$)/i.test(lowerUrl)) return "audio";

  return "file";
}

function buildDisplayMedia(msg: MessageItem): MediaMetaItem[] {
  if (msg.mediaMeta && msg.mediaMeta.length > 0) {
    return msg.mediaMeta;
  }

  return (msg.mediaUrls || []).map((url) => ({
    url,
    contentType: "",
  }));
}

// A real messaging app doesn't stamp every single bubble with a time and a
// redundant "inbound"/"outbound" label - it shows a centered divider only
// where it's actually useful: the start of a new day, or after a long
// enough gap that the time is worth calling out again. Anything closer
// together than that renders as one visual cluster with no clutter between
// bubbles, which is what makes a real chat thread feel like a chat thread.
const CLUSTER_GAP_MS = 10 * 60 * 1000;

function shouldShowDivider(current: MessageItem, previous: MessageItem | undefined) {
  if (!previous) return true;
  if (current.createdAtMs - previous.createdAtMs > CLUSTER_GAP_MS) return true;
  const a = new Date(previous.createdAtMs);
  const b = new Date(current.createdAtMs);
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
}

function formatDividerLabel(ms: number) {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isSameDay) return timePart;
  if (isYesterday) return `Yesterday ${timePart}`;

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${datePart} ${timePart}`;
}

export default function ReplyThreadPage({
  params,
}: {
  params: Promise<{ phone: string }>;
}) {
  const router = useRouter();
  const resolved = use(params);
  const routePhone = decodeURIComponent(resolved.phone || "").trim();

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previousPhoneRef = useRef<string>("");

  // If the user is already signed in when this component mounts (true for
  // any in-app navigation, as opposed to a hard page reload) and we have a
  // fresh cache entry for this exact thread, compute the initial state
  // synchronously here. This means the very first render already shows the
  // real content — there's no frame where "Checking..."/"Loading..." briefly
  // flashes before the effect below corrects it a moment later.
  const initialUid =
    typeof window !== "undefined" ? auth.currentUser?.uid : undefined;
  const initialCacheEntry = getFreshCacheEntry(initialUid, routePhone);

  const [checking, setChecking] = useState(!initialUid);
  const [loading, setLoading] = useState(!initialCacheEntry);
  const [initialLoaded, setInitialLoaded] = useState(Boolean(initialCacheEntry));
  const [sending, setSending] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [deletingThread, setDeletingThread] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [threadTitle, setThreadTitle] = useState(() => {
    if (initialCacheEntry) {
      return initialCacheEntry.meta.name
        ? `${initialCacheEntry.meta.name} · ${initialCacheEntry.meta.phone}`
        : initialCacheEntry.meta.phone || routePhone || "Conversation";
    }
    return routePhone || "Conversation";
  });
  const [messages, setMessages] = useState<MessageItem[]>(
    () => initialCacheEntry?.messages || []
  );
  const [replyBody, setReplyBody] = useState("");
  const [uploadedMedia, setUploadedMedia] = useState<UploadedMediaItem[]>([]);
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<AppUser | null>(null);
  const [conversationMeta, setConversationMeta] =
    useState<ConversationMeta | null>(initialCacheEntry?.meta || null);

  // The Message Thread / Send Reply layout below is a fixed two-column CSS
  // grid ("1.15fr 0.85fr"). On a phone-width viewport that produces a grid
  // blowout: neither column has a min-width, so their content refuses to
  // shrink past its own natural width and the whole grid (and page) ends up
  // wider than the screen - the exact "have to scroll sideways, buttons look
  // squished, Send Reply panel is cut off" layout reported on mobile.
  // Collapsing to a single column below the same 880px breakpoint used on
  // /replies fixes it at the source instead of trying to shrink content to
  // fit a column it was never going to fit in.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const MOBILE_BREAKPOINT = 880;
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // iMessage-style mobile layout: Pin/Delete/Refresh move behind a small
  // "..." menu in the compact top bar instead of three buttons competing
  // for space with the contact name, matching how a real messaging app
  // tucks secondary actions away instead of showing them all the time.
  const [showThreadMenu, setShowThreadMenu] = useState(false);

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "end",
      });
    });
  }

  function cacheKeyFor(profileArg: AppUser, phone: string) {
    return `${profileArg.uid}_${normalizePhone(phone)}`;
  }

  function makeMessageItem(id: string, data: Record<string, any>): MessageItem {
    const timeValue = data.createdAt || data.updatedAt || null;
    const mediaMeta = normalizeMediaMeta(data.mediaMeta);
    const mediaUrls =
      mediaMeta.length > 0
        ? mediaMeta.map((item) => item.url)
        : normalizeMediaUrls(data.mediaUrls);

    return {
      id,
      sid: safeString(data.sid || data.messageSid || data.twilioSid),
      from: safeString(data.from),
      to: safeString(data.to),
      body: safeString(data.body || data.message || data.text),
      direction: safeString(data.direction || data.type).toLowerCase(),
      status: safeString(data.status),
      read: !!data.read,
      mediaUrls,
      mediaMeta,
      numMedia: Number(data.numMedia || mediaUrls.length || 0),
      error: safeString(data.error),
      errorCode: safeString(data.errorCode),
      createdAtLabel: formatFirestoreDateNY(timeValue),
      createdAtMs: toMillis(timeValue),
    };
  }

  function buildFallbackConversationMessage(
    meta: ConversationMeta
  ): MessageItem[] {
    const fallbackBody = safeString(meta.lastMessage);
    if (!fallbackBody) return [];

    const fallbackDirection =
      safeString(meta.lastDirection).toLowerCase() === "inbound"
        ? "inbound"
        : "outbound";

    const twilioSideNumber = safeString(
      meta.twilioNumber || meta.assignedTwilioNumber
    );

    const fallbackTime = meta.lastMessageAt || meta.updatedAt || null;

    return [
      {
        id: `fallback-${meta.id}`,
        sid: "",
        from: fallbackDirection === "inbound" ? meta.phone : twilioSideNumber,
        to: fallbackDirection === "outbound" ? meta.phone : twilioSideNumber,
        body: fallbackBody,
        direction: fallbackDirection,
        status: "saved",
        read: true,
        mediaUrls: [],
        mediaMeta: [],
        numMedia: 0,
        createdAtLabel: formatFirestoreDateNY(fallbackTime),
        createdAtMs: toMillis(fallbackTime),
      },
    ];
  }

  async function safeGetDocs(q: Query<DocumentData>) {
    try {
      const snap = await getDocs(q);
      return snap.docs;
    } catch (error) {
      console.error("Query failed", error);
      return [];
    }
  }

  async function markConversationRead(
    metaArg?: ConversationMeta,
    profileArg?: AppUser
  ) {
    try {
      const currentMeta = metaArg || conversationMeta;
      const currentProfile = profileArg || profile;

      if (!currentMeta?.id || !currentProfile) return;

      const convoRef = doc(db, "conversations", currentMeta.id);
      await updateDoc(convoRef, {
        unreadCount: 0,
      });
    } catch (error) {
      console.error("Failed to mark conversation read", error);
    }
  }

  async function loadConversationMeta(profileArg?: AppUser, presetSnap?: any) {
    try {
      if (!routePhone) {
        setStatus("Phone number is missing.");
        return null;
      }

      const currentProfile = profileArg || profile;
      if (!currentProfile) {
        setStatus("User profile is missing.");
        return null;
      }

      setStatus("");

      const ownedConversationId = `${currentProfile.uid}_${phoneDocId(routePhone)}`;
      const ownedConversationSnap =
        presetSnap ??
        (await getDoc(doc(db, "conversations", ownedConversationId)));

      if (!ownedConversationSnap.exists()) {
        setStatus("Conversation not found.");
        setConversationMeta(null);
        setThreadTitle(routePhone || "Conversation");
        return null;
      }

      const data = ownedConversationSnap.data() as Record<string, any>;

      if (safeString(data.ownerUid) !== currentProfile.uid) {
        setStatus("Access denied.");
        setConversationMeta(null);
        return null;
      }

      const meta: ConversationMeta = {
        id: ownedConversationSnap.id,
        phone: safeString(data.phone || routePhone),
        name: safeString(data.name),
        status: safeString(data.status),
        hasReply: data.hasReply === true,
        unreadCount: Number(data.unreadCount || 0),
        lastDirection: safeString(data.lastDirection),
        twilioNumber: safeString(data.twilioNumber),
        assignedTwilioNumber: safeString(data.assignedTwilioNumber),
        messagingServiceSid: safeString(data.messagingServiceSid),
        ownerUid: safeString(data.ownerUid),
        lastMessage: safeString(data.lastMessage),
        lastMessageAt: data.lastMessageAt || null,
        updatedAt: data.updatedAt || null,
        pinned: data.pinned === true,
        blocked: data.blocked === true,
      };

      setConversationMeta(meta);
      setThreadTitle(
        meta.name ? `${meta.name} · ${meta.phone}` : meta.phone || "Conversation"
      );
      return meta;
    } catch (error: any) {
      console.error("[loadConversationMeta]", error);
      setStatus(error?.message || "Failed to load conversation.");
      return null;
    }
  }

  async function loadThreadOnce(
    metaArg?: ConversationMeta,
    profileArg?: AppUser,
    opts?: { silent?: boolean; presetSubMessagesDocs?: any[] }
  ) {
    try {
      const currentMeta = metaArg || conversationMeta;
      const currentProfile = profileArg || profile;

      if (!opts?.silent && !initialLoaded) {
        setLoading(true);
      }

      setStatus("");

      if (!currentProfile || !currentMeta?.id) {
        setMessages([]);
        return;
      }

      const store = new Map<string, MessageItem>();
      const targetPhone = normalizePhone(currentMeta.phone || "");

      const addToStore = (
        prefix: string,
        id: string,
        data: Record<string, any>
      ) => {
        const ownerUid = safeString(data.ownerUid || data.userId);
        const conversationId = safeString(data.conversationId);
        const from = normalizePhone(safeString(data.from));
        const to = normalizePhone(safeString(data.to));
        const phone = normalizePhone(safeString(data.phone));

        const matchesLegacyPhone =
          from === targetPhone || to === targetPhone || phone === targetPhone;

        const matchesConversation =
          conversationId === currentMeta.id ||
          (ownerUid === currentProfile.uid && matchesLegacyPhone);

        if (!matchesConversation) return;

        const item = makeMessageItem(`${prefix}-${id}`, data);
        const dedupeKey =
          item.sid ||
          `${item.direction}_${normalizePhone(item.from || "")}_${normalizePhone(
            item.to || ""
          )}_${item.body}_${(item.mediaUrls || []).join("|")}_${item.createdAtMs}`;

        store.set(dedupeKey, item);
      };

      const buildSortedMessages = () => {
        let merged = Array.from(store.values()).sort(
          (a, b) => a.createdAtMs - b.createdAtMs
        );
        if (merged.length === 0) {
          merged = buildFallbackConversationMessage(currentMeta);
        }
        return merged;
      };

      const paintAndCache = (merged: MessageItem[]) => {
        setMessages(merged);
        threadCache.set(cacheKeyFor(currentProfile, currentMeta.phone), {
          meta: currentMeta,
          messages: merged,
          ts: Date.now(),
        });
      };

      // Phase 1 — the per-conversation subcollection is the canonical
      // store every send/inbound path writes to today (see
      // tools/audit-message-storage-overlap.ts), so it alone almost always
      // has the full thread. Measured live: each Firestore round-trip in
      // this environment takes ~500ms and, worse, the SDK's requests queue
      // up *serially* rather than running concurrently even when fired via
      // Promise.all — so awaiting all 9 legacy+sub queries up front (the
      // old approach) meant ~4-4.5s of dead time before anything painted.
      // Painting off this one query first removes 8 of those 9 round-trips
      // from the critical path the user actually watches.
      const subMessagesDocs =
        opts?.presetSubMessagesDocs ??
        (await safeGetDocs(
          query(
            collection(db, "conversations", currentMeta.id, "messages"),
            where("ownerUid", "==", currentProfile.uid),
            orderBy("createdAt", "asc")
          )
        ));
      subMessagesDocs.forEach((d) => {
        addToStore("conv", d.id, d.data() as Record<string, any>);
      });

      paintAndCache(buildSortedMessages());
      setLoading(false);
      setInitialLoaded(true);
      setTimeout(() => {
        scrollToBottom(false);
      }, 60);

      await markConversationRead(currentMeta, currentProfile);

      // Phase 2 — legacy root `messages`/`replies` collections, kept only
      // for older conversations predating the subcollection becoming the
      // single source of truth. Runs after the thread is already on
      // screen, so its latency is invisible; only repaints if it actually
      // turns up something the subcollection didn't already have.
      const rootMessageQueries: Query<DocumentData>[] = [
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("conversationId", "==", currentMeta.id)
        ),
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("phone", "==", currentMeta.phone)
        ),
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("to", "==", currentMeta.phone)
        ),
        query(
          collection(db, "messages"),
          where("ownerUid", "==", currentProfile.uid),
          where("from", "==", currentMeta.phone)
        ),
      ];

      const rootReplyQueries: Query<DocumentData>[] = [
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("conversationId", "==", currentMeta.id)
        ),
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("phone", "==", currentMeta.phone)
        ),
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("to", "==", currentMeta.phone)
        ),
        query(
          collection(db, "replies"),
          where("ownerUid", "==", currentProfile.uid),
          where("from", "==", currentMeta.phone)
        ),
      ];

      try {
        const beforeLegacyCount = store.size;

        const restResults = await Promise.all([
          ...rootMessageQueries.map((q) => safeGetDocs(q)),
          ...rootReplyQueries.map((q) => safeGetDocs(q)),
        ]);

        const messageResults = restResults.slice(0, rootMessageQueries.length);
        const replyResults = restResults.slice(rootMessageQueries.length);

        messageResults.forEach((docs) => {
          docs.forEach((d) => {
            addToStore("msg", d.id, d.data() as Record<string, any>);
          });
        });

        replyResults.forEach((docs) => {
          docs.forEach((d) => {
            addToStore("reply", d.id, d.data() as Record<string, any>);
          });
        });

        if (store.size !== beforeLegacyCount) {
          paintAndCache(buildSortedMessages());
        }
      } catch (legacyError) {
        // Non-fatal — the subcollection paint above already succeeded.
        console.error("Legacy message fallback check failed", legacyError);
      }
    } catch (error: any) {
      console.error("[loadThreadOnce]", error);
      setStatus(error?.message || "Failed to refresh conversation.");
      setMessages([]);
      setLoading(false);
      setInitialLoaded(true);
      setTimeout(() => {
        scrollToBottom(false);
      }, 60);
    }
  }

  async function handleManualRefresh() {
    const meta = await loadConversationMeta();
    if (!meta) return;
    await loadThreadOnce(meta, undefined, { silent: true });
  }

  async function handleTogglePin() {
    if (!conversationMeta) return;

    try {
      setPinning(true);
      const nextPinned = !conversationMeta.pinned;

      await updateDoc(doc(db, "conversations", conversationMeta.id), {
        pinned: nextPinned,
        updatedAt: serverTimestamp(),
      });

      setConversationMeta((prev) =>
        prev ? { ...prev, pinned: nextPinned } : prev
      );

      setStatus(
        nextPinned
          ? "Pinned. This conversation now shows under the Pinned tab in Replies."
          : "Unpinned. This conversation moved back to its normal tab in Replies."
      );
    } catch (error: any) {
      console.error("Failed to toggle pin", error);
      setStatus(error?.message || "Failed to update pin status.");
    } finally {
      setPinning(false);
    }
  }

  async function handleDeleteThread() {
    if (!conversationMeta) return;

    const ok = window.confirm(
      "Delete this conversation? This will permanently remove the thread and cannot be undone."
    );
    if (!ok) return;

    try {
      setDeletingThread(true);
      await deleteDoc(doc(db, "conversations", conversationMeta.id));
      router.push("/replies");
    } catch (error: any) {
      console.error("Failed to delete conversation", error);
      setStatus(error?.message || "Failed to delete conversation.");
      setDeletingThread(false);
    }
  }

  useEffect(() => {
    if (!routePhone) return;

    // Navigating to a different conversation while this component stays
    // mounted (React reuses the instance across dynamic route param
    // changes). Without this reset, `initialLoaded` and stale message
    // state from the PREVIOUS thread leak into the new one, which is
    // what caused the loading skeleton to appear stuck / show wrong
    // counts. Hard-reset the moment the phone actually changes.
    if (previousPhoneRef.current !== routePhone) {
      previousPhoneRef.current = routePhone;
      setMessages([]);
      setConversationMeta(null);
      setThreadTitle(routePhone || "Conversation");
      setInitialLoaded(false);
      setLoading(true);
      setStatus("");
    }

    let unsubConversationMessages: (() => void) | undefined;
    let unsubAuth: (() => void) | undefined;
    // Set once the initial auth-gate try block resolves the signed-in
    // user's profile - read by the messages listener's callback below,
    // which is defined (and can start firing) before that profile exists
    // yet, since the subscription itself is now set up independently of
    // that fallible chain. See the comment where subscribeToMessages is
    // defined for why.
    let currentProfileForListener: AppUser | null = null;
    let messagesRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelledMessagesSub = false;

    unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        await signOut(auth).catch(() => {});
        router.push("/login");
        return;
      }

      const conversationId = `${user.uid}_${phoneDocId(routePhone)}`;

      // Subscribed here, independently of the try block below, and with
      // its own retry loop. Root cause of "have to refresh to see new
      // replies": Firestore's onSnapshot treats permission-denied as a
      // TERMINAL error and never retries on its own - and we saw this
      // exact error fire transiently (a timing race right after sign-in,
      // before the auth token is fully attached) on conversations whose
      // data and rules were independently verified to be completely fine
      // via the Admin SDK. Previously this subscription lived inside the
      // same try block as the initial paint logic (getDoc/loadThreadOnce
      // etc.), so if ANY of those threw first - for any transient reason -
      // execution never even reached the onSnapshot call, silently
      // leaving the page live-update-free for the rest of the session
      // with no visible sign anything was wrong (the initial paint still
      // looked fine, painted from cache). Moving it out here and retrying
      // on error means a one-off hiccup heals itself a couple seconds
      // later instead of requiring a manual page reload.
      const subscribeToMessages = (attempt = 0) => {
        if (cancelledMessagesSub) return;
        unsubConversationMessages?.();
        unsubConversationMessages = onSnapshot(
          query(
            collection(db, "conversations", conversationId, "messages"),
            orderBy("createdAt", "asc")
          ),
          async () => {
            if (!currentProfileForListener) return;
            const latestMeta = await loadConversationMeta(currentProfileForListener);
            if (!latestMeta) return;
            await loadThreadOnce(latestMeta, currentProfileForListener, {
              silent: true,
            });
          },
          (error: any) => {
            console.error("[messages onSnapshot]", error);
            if (cancelledMessagesSub) return;
            const delay = Math.min(2000 * (attempt + 1), 10000);
            messagesRetryTimer = setTimeout(() => subscribeToMessages(attempt + 1), delay);
          }
        );
      };

      subscribeToMessages();

      try {
        // These three reads only need `user.uid` and `routePhone`, both
        // already known synchronously right here — none actually depends
        // on another's *contents*. Firing them together (instead of the
        // old profile -> conversation -> messages chain, each strictly
        // awaited one after another) removes 2 of the 3 sequential
        // round-trips that used to sit between sign-in and the thread
        // actually painting (each round-trip runs ~200-500ms here).
        const [userSnap, conversationSnapEarly, subMessagesDocsEarly] =
          await Promise.all([
            getDoc(doc(db, "users", user.uid)),
            getDoc(doc(db, "conversations", conversationId)),
            safeGetDocs(
              query(
                collection(db, "conversations", conversationId, "messages"),
                where("ownerUid", "==", user.uid),
                orderBy("createdAt", "asc")
              )
            ),
          ]);

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

        currentProfileForListener = safeProfile;
        setProfile(safeProfile);
        setChecking(false);

        // Instant paint from cache (no loading state at all) — but only
        // if that cache is still fresh. A cache entry from a much earlier
        // session can be badly out of date (missing dozens of newer
        // messages), and briefly flashing that stale snapshot before the
        // real fetch replaces it is confusing. Anything older than this
        // window just shows the plain loading text instead.
        //
        // Note: if the lazy state initializers above already picked this
        // exact cache entry up synchronously on mount (the common case —
        // already-signed-in user, fresh cache), this is a no-op re-set of
        // the same values, not a second visible state change.
        const cached = getFreshCacheEntry(safeProfile.uid, routePhone);

        if (cached) {
          setConversationMeta(cached.meta);
          setThreadTitle(
            cached.meta.name
              ? `${cached.meta.name} · ${cached.meta.phone}`
              : cached.meta.phone || "Conversation"
          );
          setMessages(cached.messages);
          setLoading(false);
          setInitialLoaded(true);
          setTimeout(() => scrollToBottom(false), 60);
        }

        const meta = await loadConversationMeta(safeProfile, conversationSnapEarly);
        if (!meta) {
          if (!cached) {
            setLoading(false);
            setMessages([]);
          }
          return;
        }

        await loadThreadOnce(meta, safeProfile, {
          silent: Boolean(cached),
          presetSubMessagesDocs: subMessagesDocsEarly,
        });
        // Live listener for new messages is already set up above
        // (subscribeToMessages), independently of this block - see the
        // comment there for why it moved out of this try/catch.
      } catch (error: any) {
        console.error("[auth-gate outer catch]", error);
        setStatus(error?.message || "Failed to load conversation.");
        setMessages([]);
        setLoading(false);
      }
    });

    return () => {
      cancelledMessagesSub = true;
      if (messagesRetryTimer) clearTimeout(messagesRetryTimer);
      if (unsubAuth) unsubAuth();
      if (unsubConversationMessages) unsubConversationMessages();
    };
  }, [routePhone, router]);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const currentUser = auth.currentUser;

    if (!currentUser) {
      setStatus("You are not signed in.");
      return;
    }

    try {
      setUploadingMedia(true);
      setStatus("Uploading media...");

      const storagePath = `outbound_mms/${currentUser.uid}/${Date.now()}-${file.name}`;
      const storageRef = ref(storage, storagePath);

      await uploadBytes(storageRef, file, {
        contentType: file.type || "application/octet-stream",
      });

      const downloadURL = await getDownloadURL(storageRef);

      setUploadedMedia((prev) => [
        ...prev,
        {
          url: downloadURL,
          contentType: file.type || "",
          name: file.name,
        },
      ]);

      setStatus("Media uploaded.");
    } catch (error: any) {
      console.error("[handleFileChange]", error);
      setStatus(error?.message || "Failed to upload media.");
    } finally {
      setUploadingMedia(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleRemoveUploadedMedia(url: string) {
    setUploadedMedia((prev) => prev.filter((item) => item.url !== url));
  }

  async function handleSendReply() {
    if (!conversationMeta?.phone) {
      setStatus("Phone number is missing.");
      return;
    }

    if (conversationMeta.blocked) {
      setStatus("This number is blocked. Unblock it before sending a message.");
      return;
    }

    const mediaUrls = uploadedMedia.map((item) => item.url).filter(Boolean);

    if (!replyBody.trim() && mediaUrls.length === 0) {
      setStatus("Please write a reply or upload at least one file.");
      return;
    }

    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : "";

      if (!idToken) {
        setStatus("You are not signed in.");
        return;
      }

      setSending(true);
      setStatus("Sending reply...");

      const res = await fetch("/api/send-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          to: conversationMeta.phone,
          phone: conversationMeta.phone,
          body: replyBody.trim(),
          name: conversationMeta.name || "",
          mediaUrls,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus(data.error || "Failed to send reply.");
        return;
      }

      setReplyBody("");
      setUploadedMedia([]);
      setStatus("Reply sent.");
      await handleManualRefresh();

      setTimeout(() => {
        scrollToBottom(true);
      }, 150);
    } catch (error: any) {
      console.error("[handleSend]", error);
      setStatus(error?.message || "Failed to send reply.");
    } finally {
      setSending(false);
    }
  }

  const isBlocked = conversationMeta?.blocked === true;

  if (checking) {
    return isMobile ? (
      <div style={imgCheckingScreenStyle}>Checking account access...</div>
    ) : (
      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <section style={threadPanelStyle}>
            <div style={emptyStateStyle}>
              <div style={emptyTitleStyle}>Checking account access...</div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  // iMessage-style phone layout: a compact top bar (back arrow + contact
  // name + a "..." menu for Pin/Delete/Refresh instead of three competing
  // buttons), a full-height message scroll area with real chat bubbles
  // instead of "inbound/outbound" labeled cards, and a fixed bottom
  // compose bar - the same shape as every native texting app, instead of
  // the desktop two-column workspace squeezed into one column. Desktop
  // keeps the existing hero/grid layout untouched below.
  if (isMobile) {
    let previousMsg: MessageItem | undefined;
    const lastOutboundIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].direction !== "inbound") return i;
      }
      return -1;
    })();

    const contactInitials = conversationMeta?.name
      ? conversationMeta.name
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((word) => word[0])
          .join("")
          .toUpperCase()
      : "";

    return (
      <div style={imgScreenStyle}>
        <div style={imgTopBarStyle}>
          <Link href="/replies" style={imgBackButtonStyle} aria-label="Back to Replies">
            ‹
          </Link>

          <div style={imgAvatarStyle}>
            {contactInitials || "💬"}
          </div>

          <div style={imgTitleWrapStyle}>
            <div style={imgTitleStyle}>
              {conversationMeta?.name || conversationMeta?.phone || routePhone || "Conversation"}
            </div>
            {conversationMeta?.name ? (
              <div style={imgSubtitleStyle}>{conversationMeta.phone}</div>
            ) : null}
          </div>

          <div style={imgMenuWrapStyle}>
            <button
              type="button"
              onClick={() => setShowThreadMenu((v) => !v)}
              style={imgMenuButtonStyle}
              aria-label="Conversation options"
            >
              •••
            </button>

            {showThreadMenu ? (
              <div style={imgMenuDropdownStyle}>
                <button
                  type="button"
                  disabled={pinning || !conversationMeta}
                  onClick={() => {
                    setShowThreadMenu(false);
                    void handleTogglePin();
                  }}
                  style={imgMenuItemStyle}
                >
                  {pinning
                    ? "Updating..."
                    : conversationMeta?.pinned
                      ? "📌 Unpin"
                      : "📌 Pin"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowThreadMenu(false);
                    void handleManualRefresh();
                  }}
                  style={imgMenuItemStyle}
                >
                  🔄 Refresh
                </button>

                <button
                  type="button"
                  disabled={deletingThread || !conversationMeta}
                  onClick={() => {
                    setShowThreadMenu(false);
                    void handleDeleteThread();
                  }}
                  style={{ ...imgMenuItemStyle, color: "#dc2626" }}
                >
                  {deletingThread ? "Deleting..." : "🗑️ Delete Conversation"}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div
          style={imgScrollAreaStyle}
          onClick={() => {
            if (showThreadMenu) setShowThreadMenu(false);
          }}
        >
          {loading ? (
            <div style={imgLoadingStyle}>Loading conversation...</div>
          ) : messages.length === 0 ? (
            <div style={imgEmptyStyle}>No messages yet.</div>
          ) : (
            <>
              {messages.map((msg, index) => {
                const inbound = msg.direction === "inbound";
                const failed = !inbound && isFailedMessageStatus(msg.status);
                const displayMedia = buildDisplayMedia(msg);
                const showDivider = shouldShowDivider(msg, previousMsg);
                previousMsg = msg;

                return (
                  <div key={msg.id}>
                    {showDivider ? (
                      <div style={imgDividerStyle}>
                        {formatDividerLabel(msg.createdAtMs)}
                      </div>
                    ) : null}

                    <div
                      style={{
                        display: "flex",
                        width: "100%",
                        minWidth: 0,
                        alignItems: "flex-end",
                        gap: 6,
                        justifyContent: inbound ? "flex-start" : "flex-end",
                      }}
                    >
                      {inbound ? (
                        <div style={imgMessageAvatarStyle}>
                          {contactInitials || "💬"}
                        </div>
                      ) : null}

                      <div
                        style={{
                          ...imgBubbleStyle,
                          ...(inbound
                            ? imgInboundBubbleStyle
                            : failed
                              ? imgFailedBubbleStyle
                              : imgOutboundBubbleStyle),
                        }}
                      >
                        {msg.body ? (
                          <div style={imgBubbleTextStyle}>{msg.body}</div>
                        ) : null}

                        {displayMedia.length > 0 ? (
                          <div style={mediaGridStyle}>
                            {displayMedia.map((item, mIndex) => {
                              const kind = getMediaKind(item.url, item.contentType);

                              if (kind === "image") {
                                return (
                                  <a
                                    key={`${msg.id}-media-${mIndex}`}
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={mediaLinkResetStyle}
                                  >
                                    <img
                                      src={item.url}
                                      alt={`attachment-${mIndex + 1}`}
                                      style={imageAttachmentStyle}
                                    />
                                  </a>
                                );
                              }

                              if (kind === "video") {
                                return (
                                  <video
                                    key={`${msg.id}-media-${mIndex}`}
                                    controls
                                    playsInline
                                    preload="metadata"
                                    style={videoAttachmentStyle}
                                  >
                                    <source
                                      src={item.url}
                                      type={item.contentType || undefined}
                                    />
                                  </video>
                                );
                              }

                              if (kind === "audio") {
                                return (
                                  <div
                                    key={`${msg.id}-media-${mIndex}`}
                                    style={fileAttachmentStyle}
                                  >
                                    <div style={fileBadgeStyle}>Audio</div>
                                    <audio controls preload="metadata" style={audioAttachmentStyle}>
                                      <source
                                        src={item.url}
                                        type={item.contentType || undefined}
                                      />
                                    </audio>
                                  </div>
                                );
                              }

                              return (
                                <div
                                  key={`${msg.id}-media-${mIndex}`}
                                  style={fileAttachmentStyle}
                                >
                                  <div style={fileBadgeStyle}>Attachment</div>
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={fileLinkStyle}
                                  >
                                    Open file {mIndex + 1}
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}

                        {failed ? (
                          <div style={imgBubbleErrorStyle}>
                            {describeTwilioError(msg.errorCode, msg.error)}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {!inbound && !failed && index === lastOutboundIndex && msg.status ? (
                      <div style={imgDeliveredStyle}>
                        {msg.status === "delivered"
                          ? "Delivered"
                          : msg.status === "read"
                            ? "Read"
                            : msg.status}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              <div ref={threadEndRef} />
            </>
          )}
        </div>

        <div style={imgInputBarWrapStyle}>
          {isBlocked ? (
            <div style={imgBlockedBannerStyle}>
              This number is blocked - unblock it from the ⋯ menu on the
              Replies list to send messages.
            </div>
          ) : null}

          {status ? <div style={imgStatusStyle}>{status}</div> : null}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*,.pdf"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />

          {uploadedMedia.length > 0 ? (
            <div style={imgUploadedRowStyle}>
              {uploadedMedia.map((item) => (
                <div key={item.url} style={imgUploadedChipStyle}>
                  <span style={imgUploadedNameStyle}>{item.name}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveUploadedMedia(item.url)}
                    style={imgUploadedRemoveStyle}
                    aria-label={`Remove ${item.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div style={imgInputRowStyle}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingMedia || isBlocked}
              style={{
                ...imgAttachButtonStyle,
                opacity: uploadingMedia || isBlocked ? 0.5 : 1,
              }}
              aria-label="Attach photo or file"
            >
              {uploadingMedia ? "…" : "+"}
            </button>

            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              rows={1}
              placeholder={isBlocked ? "This number is blocked" : "Text Message"}
              disabled={isBlocked}
              style={{
                ...imgTextInputStyle,
                ...(isBlocked ? disabledFieldStyle : null),
              }}
            />

            <button
              type="button"
              onClick={handleSendReply}
              disabled={
                isBlocked ||
                sending ||
                uploadingMedia ||
                (!replyBody.trim() && uploadedMedia.length === 0)
              }
              style={{
                ...imgSendButtonStyle,
                opacity:
                  isBlocked ||
                  sending ||
                  uploadingMedia ||
                  (!replyBody.trim() && uploadedMedia.length === 0)
                    ? 0.4
                    : 1,
              }}
              aria-label="Send message"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <style jsx global>{`
        textarea::placeholder {
          color: rgba(100, 116, 139, 0.9);
        }
      `}</style>

      <main style={pageStyle}>
        <div style={pageWrapStyle}>
          <div style={heroStyle}>
            <div style={heroOverlayStyle} />

            <div style={heroInnerStyle}>
              <div>
                <div style={heroBadgeStyle}>Conversation Workspace</div>
                <h1 style={heroTitleStyle}>{threadTitle}</h1>
                <p style={heroTextStyle}>
                  View the full SMS and MMS thread, monitor inbound and outbound
                  messages, and send replies from the same premium panel.
                </p>
              </div>

              <div
                style={{
                  ...heroActionsStyle,
                  ...(isMobile ? { flexDirection: "column", alignItems: "stretch" } : null),
                }}
              >
                <div style={heroInfoChipStyle}>
                  <span style={heroInfoLabelStyle}>Phone</span>
                  <span style={heroInfoValueStyle}>
                    {conversationMeta?.phone || routePhone || "-"}
                  </span>
                </div>

                <Link
                  href="/replies"
                  style={{
                    ...backButtonStyle,
                    ...(isMobile ? { textAlign: "center" as const } : null),
                  }}
                >
                  Back to Replies
                </Link>
              </div>
            </div>
          </div>

          <div
            style={{
              ...mainGridStyle,
              ...(isMobile ? { gridTemplateColumns: "1fr" } : null),
            }}
          >
            <section style={{ ...threadPanelStyle, minWidth: 0 }}>
              <div style={panelHeaderStyle}>
                <div>
                  <h2 style={panelTitleStyle}>Message Thread</h2>
                  <p style={panelDescStyle}>
                    Full customer conversation history.
                  </p>
                </div>

                <div
                  style={{
                    ...panelHeaderActionsStyle,
                    ...(isMobile ? { width: "100%" } : null),
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void handleTogglePin()}
                    disabled={pinning || !conversationMeta}
                    style={{
                      ...pinButtonStyle,
                      ...(isMobile ? { flex: "1 1 0" } : null),
                      opacity: pinning || !conversationMeta ? 0.6 : 1,
                      cursor:
                        pinning || !conversationMeta
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {pinning
                      ? "Updating..."
                      : conversationMeta?.pinned
                        ? "📌 Unpin"
                        : "📌 Pin"}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleDeleteThread()}
                    disabled={deletingThread || !conversationMeta}
                    style={{
                      ...deleteThreadButtonStyle,
                      ...(isMobile ? { flex: "1 1 0" } : null),
                      opacity: deletingThread || !conversationMeta ? 0.6 : 1,
                      cursor:
                        deletingThread || !conversationMeta
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {deletingThread ? "Deleting..." : "Delete"}
                  </button>

                  <button
                    onClick={() => void handleManualRefresh()}
                    style={{
                      ...refreshButtonStyle,
                      ...(isMobile ? { flex: "1 1 0" } : null),
                    }}
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {loading ? (
                <div style={threadLoadingWrapStyle}>
                  <span style={threadLoadingTextStyle}>
                    Loading conversation...
                  </span>
                </div>
              ) : messages.length === 0 ? (
                <div style={emptyStateStyle}>
                  <div style={emptyDotStyle} />
                  <div style={emptyTitleStyle}>No messages yet.</div>
                  <div style={emptyTextStyle}>
                    This conversation does not have any saved messages yet.
                  </div>
                </div>
              ) : (
                <div style={threadWrapStyle}>
                  {messages.map((msg) => {
                    const inbound = msg.direction === "inbound";
                    const failed = !inbound && isFailedMessageStatus(msg.status);
                    const displayMedia = buildDisplayMedia(msg);

                    return (
                      <div
                        key={msg.id}
                        style={{
                          display: "flex",
                          justifyContent: inbound ? "flex-start" : "flex-end",
                        }}
                      >
                        <div
                          style={{
                            ...messageBubbleStyle,
                            ...(inbound
                              ? inboundBubbleStyle
                              : failed
                              ? failedBubbleStyle
                              : outboundBubbleStyle),
                            color: inbound ? "#0f172a" : "#ffffff",
                          }}
                        >
                          <div style={bubbleTopStyle}>
                            <span
                              style={{
                                ...bubbleDirectionStyle,
                                ...(inbound
                                  ? inboundDirectionStyle
                                  : outboundDirectionStyle),
                              }}
                            >
                              {msg.direction || "message"}
                            </span>

                            {msg.status ? (
                              <span
                                style={{
                                  ...bubbleStatusStyle,
                                  color: inbound
                                    ? "#64748b"
                                    : "rgba(236,254,255,0.84)",
                                }}
                              >
                                {msg.status}
                              </span>
                            ) : null}
                          </div>

                          {msg.body ? (
                            <div style={bubbleBodyStyle}>{msg.body}</div>
                          ) : null}

                          {displayMedia.length > 0 ? (
                            <div style={mediaGridStyle}>
                              {displayMedia.map((item, index) => {
                                const kind = getMediaKind(
                                  item.url,
                                  item.contentType
                                );

                                if (kind === "image") {
                                  return (
                                    <a
                                      key={`${msg.id}-media-${index}`}
                                      href={item.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      style={mediaLinkResetStyle}
                                    >
                                      <img
                                        src={item.url}
                                        alt={`attachment-${index + 1}`}
                                        style={imageAttachmentStyle}
                                      />
                                    </a>
                                  );
                                }

                                if (kind === "video") {
                                  return (
                                    <video
                                      key={`${msg.id}-media-${index}`}
                                      controls
                                      playsInline
                                      preload="metadata"
                                      style={videoAttachmentStyle}
                                    >
                                      <source
                                        src={item.url}
                                        type={item.contentType || undefined}
                                      />
                                    </video>
                                  );
                                }

                                if (kind === "audio") {
                                  return (
                                    <div
                                      key={`${msg.id}-media-${index}`}
                                      style={fileAttachmentStyle}
                                    >
                                      <div style={fileBadgeStyle}>Audio</div>
                                      <audio
                                        controls
                                        preload="metadata"
                                        style={audioAttachmentStyle}
                                      >
                                        <source
                                          src={item.url}
                                          type={item.contentType || undefined}
                                        />
                                      </audio>
                                      <a
                                        href={item.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        style={fileLinkStyle}
                                      >
                                        Open audio
                                      </a>
                                    </div>
                                  );
                                }

                                return (
                                  <div
                                    key={`${msg.id}-media-${index}`}
                                    style={fileAttachmentStyle}
                                  >
                                    <div style={fileBadgeStyle}>Attachment</div>
                                    <a
                                      href={item.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      style={fileLinkStyle}
                                    >
                                      Open file {index + 1}
                                    </a>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}

                          {failed ? (
                            <div style={bubbleErrorStyle}>
                              {describeTwilioError(msg.errorCode, msg.error)}
                            </div>
                          ) : null}

                          <div
                            style={{
                              ...bubbleTimeStyle,
                              color: inbound
                                ? "#64748b"
                                : "rgba(236,254,255,0.8)",
                            }}
                          >
                            {msg.createdAtLabel}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  <div ref={threadEndRef} />
                </div>
              )}
            </section>

            <section
              style={{
                ...composerPanelStyle,
                minWidth: 0,
                // Sticky-to-top only makes sense in the two-column desktop
                // layout, where this panel sits beside a much taller
                // scrolling thread. Stacked on mobile it would instead
                // pin itself over the message thread while scrolling.
                ...(isMobile ? { position: "static" as const, top: undefined } : null),
              }}
            >
              <div style={panelHeaderStyle}>
                <div>
                  <h2 style={panelTitleStyle}>Send Reply</h2>
                  <p style={panelDescStyle}>
                    Write a response and send it directly to this conversation.
                  </p>
                </div>
              </div>

              <div style={miniInfoGridStyle}>
                <MiniInfoCard
                  label="Recipient"
                  value={conversationMeta?.phone || routePhone || "-"}
                />
                <MiniInfoCard label="Messages" value={String(messages.length)} />
              </div>

              {isBlocked ? (
                <div style={blockedBannerStyle}>
                  This number is blocked. You can&apos;t send messages until
                  it&apos;s unblocked (from the ⋯ menu on the Replies list).
                </div>
              ) : null}

              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                rows={8}
                placeholder={
                  isBlocked
                    ? "This number is blocked - unblock it first."
                    : "Write your SMS / MMS reply..."
                }
                disabled={isBlocked}
                style={{
                  ...textareaStyle,
                  ...(isBlocked ? disabledFieldStyle : null),
                }}
              />

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,audio/*,.pdf"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />

              <div style={uploadActionRowStyle}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingMedia || isBlocked}
                  style={{
                    ...uploadButtonStyle,
                    opacity: uploadingMedia || isBlocked ? 0.6 : 1,
                    cursor: uploadingMedia || isBlocked ? "not-allowed" : "pointer",
                  }}
                >
                  {uploadingMedia ? "Uploading..." : "Upload Picture / File"}
                </button>
              </div>

              {uploadedMedia.length > 0 ? (
                <div style={uploadedMediaWrapStyle}>
                  {uploadedMedia.map((item) => {
                    const kind = getMediaKind(item.url, item.contentType);

                    return (
                      <div key={item.url} style={uploadedMediaCardStyle}>
                        {kind === "image" ? (
                          <img
                            src={item.url}
                            alt={item.name}
                            style={uploadedPreviewImageStyle}
                          />
                        ) : (
                          <div style={uploadedFileNameStyle}>{item.name}</div>
                        )}

                        <div style={uploadedMediaActionsStyle}>
                          <div style={uploadedFileNameStyle}>{item.name}</div>
                          <button
                            type="button"
                            onClick={() => handleRemoveUploadedMedia(item.url)}
                            style={removeMediaButtonStyle}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <div style={replyMetaStyle}>
                <span>Characters:</span>
                <strong>{replyBody.length}</strong>
              </div>

              <div style={buttonRowStyle}>
                <button
                  onClick={handleSendReply}
                  disabled={
                    isBlocked ||
                    sending ||
                    uploadingMedia ||
                    (!replyBody.trim() && uploadedMedia.length === 0)
                  }
                  style={{
                    ...sendButtonStyle,
                    opacity:
                      isBlocked ||
                      sending ||
                      uploadingMedia ||
                      (!replyBody.trim() && uploadedMedia.length === 0)
                        ? 0.6
                        : 1,
                    cursor:
                      isBlocked ||
                      sending ||
                      uploadingMedia ||
                      (!replyBody.trim() && uploadedMedia.length === 0)
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  {isBlocked ? "Blocked" : sending ? "Sending..." : "Send Reply"}
                </button>

                <button
                  onClick={() => void handleManualRefresh()}
                  style={secondaryButtonStyle}
                >
                  Refresh Thread
                </button>
              </div>

              {status ? <div style={statusBoxStyle}>{status}</div> : null}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

function MiniInfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniInfoCardStyle}>
      <div style={miniInfoLabelStyle}>{label}</div>
      <div style={miniInfoValueStyle}>{value}</div>
    </div>
  );
}

// --- iMessage-style mobile layout -------------------------------------
// A dedicated set of styles for the phone-width thread view (isMobile),
// separate from the desktop hero/grid styles below. Kept as its own block
// rather than reusing/overloading the desktop styles because the two
// layouts are structurally different (fixed full-screen chat vs. a
// scrolling two-column workspace), not just a resize of the same thing.

const imgCheckingScreenStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#ffffff",
  color: "#64748b",
  fontSize: 14,
  fontWeight: 600,
};

const imgScreenStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  // Soft cyan-to-slate wash with a faint radial highlight in the corner -
  // the same premium-dashboard treatment used on the desktop hero cards
  // (pageStyle/heroStyle), so this reads as "the fintech app's chat view"
  // rather than a flat, generic Messages background.
  background:
    "radial-gradient(circle at top right, rgba(20,184,166,0.10), transparent 32%), linear-gradient(180deg, #ecfeff 0%, #f1f5f9 45%, #f1f5f9 100%)",
  overflow: "hidden",
};

const imgTopBarStyle: CSSProperties = {
  position: "relative",
  // A flex-item z-index applies without needing `position` for stacking
  // purposes here (imgScreenStyle is display:flex), but Safari's handling
  // of z-index on flex items alongside backdrop-filter is inconsistent
  // unless the item is also explicitly positioned - `relative` plus this
  // z-index is what actually keeps the "..." dropdown menu (rendered
  // inside this bar) above the message thread below it. Without it,
  // backdrop-filter gives this bar its own stacking context, which traps
  // the dropdown's z-index inside that context - it can never rise above
  // a later sibling (the scrollable thread), so it rendered UNDER the
  // messages instead of floating over them.
  zIndex: 20,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "max(10px, env(safe-area-inset-top)) 10px 12px 8px",
  background: "rgba(255,255,255,0.92)",
  borderBottom: "1px solid rgba(13,148,136,0.12)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 4px 16px rgba(15,23,42,0.06)",
};

const imgBackButtonStyle: CSSProperties = {
  flexShrink: 0,
  width: 32,
  height: 36,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 28,
  lineHeight: 1,
  color: "#0d9488",
  textDecoration: "none",
};

const imgAvatarStyle: CSSProperties = {
  flexShrink: 0,
  width: 34,
  height: 34,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: 0.2,
  boxShadow: "0 2px 6px rgba(13,148,136,0.35)",
};

const imgTitleWrapStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: "left",
};

const imgTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#0f172a",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const imgSubtitleStyle: CSSProperties = {
  marginTop: 1,
  fontSize: 12,
  color: "#64748b",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const imgMenuWrapStyle: CSSProperties = {
  position: "relative",
  flexShrink: 0,
};

const imgMenuButtonStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: "50%",
  border: "none",
  background: "rgba(13,148,136,0.08)",
  color: "#0d9488",
  fontSize: 15,
  fontWeight: 900,
  cursor: "pointer",
};

const imgMenuDropdownStyle: CSSProperties = {
  position: "absolute",
  top: 44,
  right: 0,
  zIndex: 30,
  minWidth: 200,
  background: "#ffffff",
  borderRadius: 18,
  boxShadow:
    "0 20px 40px rgba(15,23,42,0.18), 0 2px 8px rgba(15,23,42,0.08)",
  border: "1px solid rgba(15,23,42,0.06)",
  overflow: "hidden",
  padding: 6,
};

const imgMenuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  textAlign: "left",
  padding: "11px 12px",
  borderRadius: 12,
  border: "none",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const imgScrollAreaStyle: CSSProperties = {
  flex: 1,
  // Both dimensions matter here: minHeight:0 lets this flex item shrink to
  // fit the column instead of growing with its content's natural height,
  // and minWidth:0 does the same on the cross axis - without it, a long
  // unbroken bubble could make this whole flex item (and everything in it)
  // wider than the screen, which is exactly what clipped bubbles/text at
  // the right edge and required a sideways scroll to see the rest.
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  overflowY: "auto",
  overflowX: "hidden",
  WebkitOverflowScrolling: "touch",
  padding: "14px 12px",
};

const imgLoadingStyle: CSSProperties = {
  textAlign: "center",
  marginTop: 40,
  color: "#64748b",
  fontSize: 14,
  fontWeight: 600,
};

const imgEmptyStyle: CSSProperties = {
  textAlign: "center",
  marginTop: 40,
  color: "#94a3b8",
  fontSize: 14,
  fontWeight: 600,
};

// Plain centered text, no pill/chip background - matches the simple
// "Yesterday" / "Today" dividers real messaging apps use, rather than a
// styled badge calling attention to itself.
const imgDividerStyle: CSSProperties = {
  textAlign: "center",
  margin: "16px 0 10px",
  color: "#9ca3af",
  fontSize: 12.5,
  fontWeight: 600,
};

const imgMessageAvatarStyle: CSSProperties = {
  flexShrink: 0,
  width: 26,
  height: 26,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)",
  color: "#ffffff",
  fontSize: 10.5,
  fontWeight: 800,
};

const imgBubbleStyle: CSSProperties = {
  maxWidth: "72%",
  minWidth: 0,
  margin: "2px 0",
  padding: "11px 16px",
  fontSize: 15.5,
  lineHeight: 1.4,
  wordBreak: "break-word",
  overflowWrap: "anywhere",
  // Uniform, generously rounded corners on every side - a real chat "tail"
  // (one sharp corner pointing at the sender) reads as iMessage specifically;
  // fully-rounded bubbles are the more neutral, friendly shape most other
  // messaging apps use.
  borderRadius: 20,
};

const imgInboundBubbleStyle: CSSProperties = {
  background: "#f0f0f0",
  color: "#0f172a",
};

const imgOutboundBubbleStyle: CSSProperties = {
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 55%, #14b8a6 100%)",
  color: "#ffffff",
  // A soft halo around the bubble instead of a hard shadow underneath -
  // the gentle "glow" look real chat apps use to make the sent bubble
  // feel like it belongs to the brand color, not just a colored box.
  boxShadow:
    "0 0 0 3px rgba(13,148,136,0.10), 0 3px 10px rgba(13,148,136,0.25)",
};

const imgFailedBubbleStyle: CSSProperties = {
  background: "#fee2e2",
  color: "#991b1b",
  border: "1px solid rgba(220,38,38,0.25)",
};

const imgBubbleTextStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
};

const imgBubbleErrorStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 12.5,
  fontWeight: 700,
};

const imgDeliveredStyle: CSSProperties = {
  textAlign: "right",
  marginTop: 2,
  marginRight: 4,
  color: "#8e8e93",
  fontSize: 11.5,
  fontWeight: 600,
};

const imgInputBarWrapStyle: CSSProperties = {
  flexShrink: 0,
  background: "rgba(255,255,255,0.96)",
  borderTop: "1px solid rgba(13,148,136,0.12)",
  boxShadow: "0 -2px 12px rgba(15,23,42,0.04)",
  padding: "8px 10px max(8px, env(safe-area-inset-bottom)) 10px",
  backdropFilter: "blur(10px)",
};

const imgBlockedBannerStyle: CSSProperties = {
  marginBottom: 8,
  padding: "10px 12px",
  borderRadius: 12,
  background: "#fef2f2",
  border: "1px solid rgba(220,38,38,0.2)",
  color: "#b91c1c",
  fontSize: 12.5,
  fontWeight: 700,
  lineHeight: 1.4,
};

const imgStatusStyle: CSSProperties = {
  marginBottom: 8,
  padding: "8px 12px",
  borderRadius: 12,
  background: "#f1f5f9",
  color: "#0f172a",
  fontSize: 12.5,
  fontWeight: 600,
};

const imgUploadedRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  marginBottom: 8,
};

const imgUploadedChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 999,
  background: "#f1f5f9",
  border: "1px solid rgba(15,23,42,0.08)",
};

const imgUploadedNameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#0f172a",
  maxWidth: 140,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const imgUploadedRemoveStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#64748b",
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
  padding: 0,
};

const imgInputRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
};

const imgAttachButtonStyle: CSSProperties = {
  flexShrink: 0,
  width: 34,
  height: 34,
  borderRadius: "50%",
  border: "1px solid rgba(13,148,136,0.18)",
  background: "rgba(13,148,136,0.08)",
  color: "#0d9488",
  fontSize: 20,
  fontWeight: 800,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const imgTextInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  maxHeight: 110,
  resize: "none",
  borderRadius: 20,
  border: "1px solid rgba(15,23,42,0.12)",
  padding: "9px 15px",
  background: "#f8fafc",
  color: "#0f172a",
  fontSize: 15,
  lineHeight: 1.35,
  outline: "none",
};

const imgSendButtonStyle: CSSProperties = {
  flexShrink: 0,
  width: 34,
  height: 34,
  borderRadius: "50%",
  border: "none",
  background: "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)",
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 900,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "0 2px 6px rgba(13,148,136,0.35)",
};

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(20,184,166,0.18), transparent 28%), linear-gradient(180deg, #ecfeff 0%, #f8fafc 46%, #f8fafc 100%)",
  color: "#0f172a",
  padding: 24,
};

const pageWrapStyle: CSSProperties = {
  maxWidth: 1260,
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
  wordBreak: "break-word",
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

const heroInfoChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 16px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.16)",
  color: "#ffffff",
  backdropFilter: "blur(10px)",
};

const heroInfoLabelStyle: CSSProperties = {
  color: "rgba(236,254,255,0.7)",
  fontSize: 13,
  fontWeight: 700,
};

const heroInfoValueStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 900,
  wordBreak: "break-word",
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

const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.15fr 0.85fr",
  gap: 20,
  alignItems: "start",
};

const threadPanelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  minHeight: 720,
};

const composerPanelStyle: CSSProperties = {
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  backdropFilter: "blur(8px)",
  position: "sticky",
  top: 24,
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

const panelHeaderActionsStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const pinButtonStyle: CSSProperties = {
  border: "1px solid rgba(13,148,136,0.25)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "rgba(13,148,136,0.08)",
  color: "#0f766e",
  fontWeight: 800,
  cursor: "pointer",
};

const deleteThreadButtonStyle: CSSProperties = {
  border: "1px solid rgba(220,38,38,0.2)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "rgba(220,38,38,0.06)",
  color: "#b91c1c",
  fontWeight: 800,
  cursor: "pointer",
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

const threadWrapStyle: CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
  maxHeight: 650,
  overflowY: "auto",
  paddingRight: 4,
};

const messageBubbleStyle: CSSProperties = {
  maxWidth: "80%",
  borderRadius: 24,
  padding: 16,
  boxShadow: "0 10px 24px rgba(15,23,42,0.06)",
};

const inboundBubbleStyle: CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  border: "1px solid #dbeafe",
};

const outboundBubbleStyle: CSSProperties = {
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  border: "1px solid rgba(13,148,136,0.18)",
};

const failedBubbleStyle: CSSProperties = {
  background: "linear-gradient(135deg, #b91c1c 0%, #991b1b 100%)",
  border: "1px solid rgba(153,27,27,0.35)",
};

const bubbleTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

const bubbleDirectionStyle: CSSProperties = {
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 11,
  fontWeight: 900,
  textTransform: "capitalize",
  letterSpacing: 0.2,
};

const inboundDirectionStyle: CSSProperties = {
  background: "rgba(59,130,246,0.10)",
  color: "#2563eb",
  border: "1px solid rgba(59,130,246,0.18)",
};

const outboundDirectionStyle: CSSProperties = {
  background: "rgba(255,255,255,0.14)",
  color: "#ecfeff",
  border: "1px solid rgba(255,255,255,0.18)",
};

const bubbleStatusStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: "capitalize",
};

const bubbleBodyStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 15,
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
};

const bubbleTimeStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  opacity: 0.82,
};

const bubbleErrorStyle: CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.16)",
  border: "1px solid rgba(255,255,255,0.25)",
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "#fff5f5",
};

const mediaGridStyle: CSSProperties = {
  marginTop: 12,
  display: "grid",
  gap: 10,
};

const mediaLinkResetStyle: CSSProperties = {
  textDecoration: "none",
};

const imageAttachmentStyle: CSSProperties = {
  width: "100%",
  maxWidth: 320,
  maxHeight: 280,
  objectFit: "cover",
  borderRadius: 16,
  display: "block",
  border: "1px solid rgba(148,163,184,0.24)",
  background: "#ffffff",
};

const videoAttachmentStyle: CSSProperties = {
  width: "100%",
  maxWidth: 340,
  borderRadius: 16,
  background: "#000000",
};

const audioAttachmentStyle: CSSProperties = {
  width: "100%",
};

const fileAttachmentStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  borderRadius: 16,
  padding: 12,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(148,163,184,0.24)",
};

const fileBadgeStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  opacity: 0.85,
};

const fileLinkStyle: CSSProperties = {
  color: "inherit",
  fontWeight: 800,
  textDecoration: "underline",
  wordBreak: "break-all",
};

const miniInfoGridStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};

const miniInfoCardStyle: CSSProperties = {
  borderRadius: 18,
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  padding: 16,
  border: "1px solid #eef2f7",
};

const miniInfoLabelStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  fontWeight: 800,
};

const miniInfoValueStyle: CSSProperties = {
  marginTop: 10,
  color: "#0f172a",
  fontSize: 16,
  fontWeight: 900,
  wordBreak: "break-word",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  marginTop: 18,
  borderRadius: 18,
  border: "1px solid #dbe3ed",
  padding: "14px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 15,
  resize: "vertical",
  outline: "none",
  minHeight: 180,
};

const disabledFieldStyle: CSSProperties = {
  background: "#f8fafc",
  color: "#94a3b8",
  cursor: "not-allowed",
};

const blockedBannerStyle: CSSProperties = {
  marginTop: 16,
  borderRadius: 16,
  padding: "14px 16px",
  background: "#fef2f2",
  border: "1px solid rgba(220,38,38,0.25)",
  color: "#b91c1c",
  fontSize: 13.5,
  fontWeight: 700,
  lineHeight: 1.5,
};

const uploadActionRowStyle: CSSProperties = {
  marginTop: 14,
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const uploadButtonStyle: CSSProperties = {
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  fontSize: 14,
};

const uploadedMediaWrapStyle: CSSProperties = {
  marginTop: 14,
  display: "grid",
  gap: 12,
};

const uploadedMediaCardStyle: CSSProperties = {
  borderRadius: 16,
  border: "1px solid #dbe3ed",
  background: "#ffffff",
  padding: 12,
  display: "grid",
  gap: 10,
};

const uploadedPreviewImageStyle: CSSProperties = {
  width: "100%",
  maxHeight: 220,
  objectFit: "cover",
  borderRadius: 12,
  display: "block",
};

const uploadedMediaActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

const uploadedFileNameStyle: CSSProperties = {
  fontSize: 13,
  color: "#475569",
  wordBreak: "break-all",
};

const removeMediaButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 10,
  padding: "8px 12px",
  background: "rgba(220,38,38,0.08)",
  color: "#b91c1c",
  fontWeight: 800,
  fontSize: 13,
  cursor: "pointer",
};

const replyMetaStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  color: "#64748b",
  fontSize: 13,
};

const buttonRowStyle: CSSProperties = {
  marginTop: 18,
  display: "grid",
  gap: 12,
};

const sendButtonStyle: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: 18,
  padding: "16px 18px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 16,
  boxShadow: "0 18px 35px rgba(13,148,136,0.24)",
};

const secondaryButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 16,
  padding: "14px 18px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  fontSize: 15,
  cursor: "pointer",
};

const statusBoxStyle: CSSProperties = {
  marginTop: 14,
  borderRadius: 18,
  padding: "14px 16px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  fontSize: 14,
  lineHeight: 1.5,
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

// No fake bubble mockup, no decorative shapes — just a plain, quiet
// line of text while the real thread loads. Nothing to animate.
const threadLoadingWrapStyle: CSSProperties = {
  marginTop: 40,
  display: "flex",
  justifyContent: "center",
};

const threadLoadingTextStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 14,
  fontWeight: 600,
};

