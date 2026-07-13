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

  async function loadConversationMeta(profileArg?: AppUser) {
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
      const ownedConversationRef = doc(db, "conversations", ownedConversationId);
      const ownedConversationSnap = await getDoc(ownedConversationRef);

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
      console.error(error);
      setStatus(error?.message || "Failed to load conversation.");
      return null;
    }
  }

  async function loadThreadOnce(
    metaArg?: ConversationMeta,
    profileArg?: AppUser,
    opts?: { silent?: boolean }
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

      // Every query is built up front, then fired together with
      // Promise.all instead of awaited one-by-one — ~9 sequential
      // round-trips collapse into roughly 1 round-trip's worth of
      // latency (whichever query is slowest).
      const subMessagesQuery = query(
        collection(db, "conversations", currentMeta.id, "messages"),
        where("ownerUid", "==", currentProfile.uid),
        orderBy("createdAt", "asc")
      );

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

      const [subMessagesDocs, ...restResults] = await Promise.all([
        safeGetDocs(subMessagesQuery),
        ...rootMessageQueries.map((q) => safeGetDocs(q)),
        ...rootReplyQueries.map((q) => safeGetDocs(q)),
      ]);

      const messageResults = restResults.slice(0, rootMessageQueries.length);
      const replyResults = restResults.slice(rootMessageQueries.length);

      subMessagesDocs.forEach((d) => {
        addToStore("conv", d.id, d.data() as Record<string, any>);
      });

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

      let merged = Array.from(store.values()).sort(
        (a, b) => a.createdAtMs - b.createdAtMs
      );

      if (merged.length === 0) {
        merged = buildFallbackConversationMessage(currentMeta);
      }

      setMessages(merged);
      threadCache.set(cacheKeyFor(currentProfile, currentMeta.phone), {
        meta: currentMeta,
        messages: merged,
        ts: Date.now(),
      });

      await markConversationRead(currentMeta, currentProfile);
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Failed to refresh conversation.");
      setMessages([]);
    } finally {
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

    unsubAuth = onAuthStateChanged(auth, async (user) => {
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

        const meta = await loadConversationMeta(safeProfile);
        if (!meta) {
          if (!cached) {
            setLoading(false);
            setMessages([]);
          }
          return;
        }

        await loadThreadOnce(meta, safeProfile, { silent: Boolean(cached) });

        const refreshFromThreadChange = async () => {
          const latestMeta = await loadConversationMeta(safeProfile);
          if (!latestMeta) return;
          await loadThreadOnce(latestMeta, safeProfile, { silent: true });
        };

        unsubConversationMessages = onSnapshot(
          query(
            collection(db, "conversations", meta.id, "messages"),
            orderBy("createdAt", "asc")
          ),
          async () => {
            await refreshFromThreadChange();
          },
          (error: any) => {
            console.error(error);
          }
        );
      } catch (error: any) {
        console.error(error);
        setStatus(error?.message || "Failed to load conversation.");
        setMessages([]);
        setLoading(false);
      }
    });

    return () => {
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
      console.error(error);
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
      console.error(error);
      setStatus(error?.message || "Failed to send reply.");
    } finally {
      setSending(false);
    }
  }

  const isBlocked = conversationMeta?.blocked === true;

  if (checking) {
    return (
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

              <div style={heroActionsStyle}>
                <div style={heroInfoChipStyle}>
                  <span style={heroInfoLabelStyle}>Phone</span>
                  <span style={heroInfoValueStyle}>
                    {conversationMeta?.phone || routePhone || "-"}
                  </span>
                </div>

                <Link href="/replies" style={backButtonStyle}>
                  Back to Replies
                </Link>
              </div>
            </div>
          </div>

          <div style={mainGridStyle}>
            <section style={threadPanelStyle}>
              <div style={panelHeaderStyle}>
                <div>
                  <h2 style={panelTitleStyle}>Message Thread</h2>
                  <p style={panelDescStyle}>
                    Full customer conversation history.
                  </p>
                </div>

                <div style={panelHeaderActionsStyle}>
                  <button
                    type="button"
                    onClick={() => void handleTogglePin()}
                    disabled={pinning || !conversationMeta}
                    style={{
                      ...pinButtonStyle,
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
                    style={refreshButtonStyle}
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

            <section style={composerPanelStyle}>
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

