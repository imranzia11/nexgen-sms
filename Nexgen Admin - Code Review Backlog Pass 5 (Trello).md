# Nexgen Admin — Code Review Backlog, Pass 5
*Generated September 20, 2026. Follow-up to the August 22, 2026 pass. Each item is a ready-to-paste Trello card: title, description, priority. Carried-over items note their prior status; new items are marked NEW.*

---

## Security

### 🔴 Critical — STILL OPEN — Lock down `twilioNumber` in Firestore rules
Unchanged since Aug 22. `firestore.rules` (`/users/{userId}` update rule) still locks `role`, `isActive`, and the sender-identity fields but never `twilioNumber`. A signed-in rep can still write their own `twilioNumber` to any value via the client SDK, and `app/api/send-sms/route.ts` still trusts whatever is on the account doc as the "from" number unchecked.

### 🔴 Critical — STILL OPEN — New account docs can self-activate
Unchanged since Aug 22. The `create` rule on `/users/{userId}` only restricts `role`; nothing blocks `isActive: true` or `senderVerified: true` on first write, so a new account could self-activate and skip approval/email verification.

---

## Bugs & Reliability

### 🟠 High — STILL OPEN — Auto-block keyword list is too aggressive
Unchanged since Aug 22. `app/api/send-sms/twilio/inbound/route.ts` still auto-blocks on ordinary words like "dumb," "stupid," "scam," "scammer," "trash," "loser," "clown," "garbage," "nonsense" — a customer asking "is this a scam?" gets permanently blocked platform-wide.

### 🟠 High — NEW — `apphosting.yaml` is missing Twilio + APP_BASE_URL secrets
`apphosting.yaml` declares `CRON_SECRET`, `SENDGRID_API_KEY`, and `NEXT_PUBLIC_FIREBASE_VAPID_KEY`, but never declares `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, or `APP_BASE_URL` — all four are read directly from `process.env` in `lib/twilioSend.ts` with no fallback. SMS works today because these are presumably set out-of-band on the backend directly, but this is the exact same class of bug that broke the first live email blast (missing declared secret). If the App Hosting backend is ever recreated from `apphosting.yaml` alone, SMS sending would silently break.

### 🟡 Medium — STILL OPEN, HIGHER STAKES — Follow-up cron has no protection against overlapping runs
Unchanged since Aug 22, but the follow-up cron's per-run cap was since raised to 500 — the same overlap bug (no claim/lock step between reading a pending follow-up and marking it sent) now has 5x the blast radius if two runs ever overlap.

### 🟡 Medium — STILL OPEN — Email blast has no protection against a retried request double-sending
Unchanged since Aug 22. `app/api/send-email-blast/route.ts` still has no idempotency key — a retried POST resends the whole batch to every recipient.

### 🟡 Medium — NEW (visual) — Loading screen is inconsistent across pages after the theme revert
`app/replies/page.tsx`, `app/replies/[phone]/page.tsx`, and `app/uploads/[uploadId]/page.tsx` were briefly swapped to the shared `LoadingScreen` component (branded teal gradient + message-send animation), but that swap sat inside the commit range that got reverted along with the dark-theme rollback — so all three reverted back to bespoke plain-text loading blocks on a bare white/gray background. The other 11 authenticated pages all use the shared component. Result: navigating dashboard → replies shows a jarring flash from a branded teal loading screen to an unstyled white panel. Not a functional bug, just a visible inconsistency.

---

## Data Integrity & Performance

### 🟡 Medium — STILL OPEN — Blacklisted page loads unbounded data
Unchanged since Aug 22. `app/blacklisted/page.tsx` still runs two live, unbounded `onSnapshot` listeners (blocked-numbers list, replies collection). Client-side pagination was added since, but it only slices data that's already been fully downloaded and kept live-synced — doesn't reduce the actual read/sync volume.

### 🟡 Medium — STILL OPEN — No cap on creating new sending emails
Unchanged since Aug 22. `app/api/email-marketing/create-sender/route.ts` still has no count check against SendGrid's 100-sender-identity cap.

### 🟢 Low — FIXED (improved) — Admin phone lookup full-scan fallback
`app/api/admin/diagnose-followups/route.ts` now does true cursor-based pagination (`orderBy(documentId()).limit(5000).startAfter(cursor)`) instead of a single unbounded query. Still scans the whole collection as a last resort, but no longer silently truncates results. Read-only, superadmin-gated — low risk either way.

---

## Dead Code & Cleanup

### 🟢 Low — STILL OPEN — Delete unused sender-verification route
`app/api/email-marketing/verify-sender/route.ts` is still unused (zero callers in `app/`) — the live page uses a different route.

### 🟢 Low — STILL OPEN — Remove leftover "Email Marketing coming soon" popups
Same 5 pages (`dashboard`, `blacklisted`, `help`, `logs`, `stats`) still carry the unused popup state/markup — confirmed zero call sites for `setShowEmailComingSoon(true)` anywhere.

### 🟠 High — STILL OPEN, WORSE — Duplicate unused bulk-send route
`app/api/send-sms/twilio/route.ts` is still a second, unused copy of the real bulk-send logic. Since Aug 22 it received a band-aid blacklist-check patch rather than being deleted — the two copies have now diverged further (still missing media support and thread-level failure logging that the real route has), meaning effort is now being spent maintaining dead code instead of removing it.

### 🟢 Low — NEW — Dead `blacklist_events` rule in firestore.rules
Rules exist for a `blacklist_events/{docId}` collection that is never read or written anywhere in `app/`, `lib/`, or `tools/`. Dead rule for a collection that doesn't exist in practice.

### 🟢 Low — NEW — Dead include path in tsconfig.json
`tsconfig.json` includes a literal path `"app/api/send-sms/twilio/send-sms"` that doesn't exist. Harmless (tsc ignores non-matching includes) but confusing/dead config.

### 🟢 Low — NEW — Unused `Papa` import in dashboard
`app/dashboard/page.tsx` still imports `Papa` from `papaparse`, but its only use now sits inside the block comment disabling CSV upload. Harmless, but worth cleaning up whenever upload is restored or the dead code removed.

### 🟢 Low — NEW (scale edge case) — Push notification multicast isn't chunked
`lib/pushNotify.ts` calls `sendEachForMulticast` with the full, unbounded `fcmTokens` array. FCM caps multicast batches at 500 tokens; nothing chunks the array. Not a problem today (token lists are small and deduped on write), but will break silently once an account's token count grows past 500.

---

## UX Gaps
*(No new items surfaced this pass beyond the LoadingScreen inconsistency noted above.)*

---

## Architecture / Scale (unchanged, still open, larger ongoing items)

### 🟠 High — Full-stack review for scaling to 1,000 accounts — still never completed
### 🟡 Medium — Thread page pagination second attempt — still not done
### 🟡 Medium — "Thread page never goes live" report — still unreproduced/unresolved
### 🟡 Medium — Confirm push notifications work end-to-end — still unconfirmed
### 🟢 Low — Audit scope of past duplicate resends — still not checked

---

**Files/areas confirmed solid this pass (no new issues):** all 10 previously-verified `lib/` files (byte-identical since Aug 22, confirmed via git history) plus `lib/pushNotify.ts`/`lib/pushClient.ts` (aside from the multicast note above); both new investigation scripts `tools/find-recent-senders.ts` and `tools/find-recent-senders-subcollection.ts` (genuinely read-only, correct field names, sound fallback logic); every `app/api/admin/*` route (all correctly verify the ID token and superadmin role server-side); `send-reply`, `schedule-follow-up`, both Twilio webhook routes (signature validation still strictly enforced); the two new `messages.createdAt` collection-group Firestore indexes (correctly scoped, no conflict with existing per-field indexes); `firebase.json`, `.gitignore`, `package.json` dependency versions; sidebar width and theme are now fully consistent across all 7 pages sharing the shell layout (the 290→240→320→640→320px cycle and the dark-theme revert left no stragglers); all `onSnapshot` listeners checked (blacklisted, replies, replies/[phone]) clean up correctly in `useEffect`; the CSV-upload block in `app/dashboard/page.tsx` is clean and easily reversible (no broken/dangling state).
