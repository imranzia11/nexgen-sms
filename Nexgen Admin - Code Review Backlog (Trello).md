# Nexgen Admin — Code Review Backlog
*Generated August 22, 2026. Each item below is written as a ready-to-paste Trello card: title, description, priority. Copy each one into its own card.*

---

## Security

### 🔴 Critical — Lock down `twilioNumber` in Firestore rules
Any signed-in rep can currently edit their own `twilioNumber` field directly (not just through the app), because `firestore.rules` only protects `role`, `isActive`, and the email sender fields on account updates. Every SMS send route trusts whatever number is on that account doc as the "from" number — so a rep could set their `twilioNumber` to someone else's number and send texts that appear to come from a different account. File: `firestore.rules` (`/users/{userId}` update rule), `app/api/send-sms/route.ts`. *(Personally verified — confirmed both the rules gap and that send-sms trusts this field unchecked.)*

### 🔴 Critical — New account docs can self-activate
When a brand-new `users/{uid}` document is created, `firestore.rules` only blocks setting `role` to something other than "user" — it doesn't block `isActive: true` or `senderVerified: true`. Anyone with a valid login session could write their own account doc directly and skip account approval and email verification entirely, gaining full send access immediately. File: `firestore.rules` (`/users/{userId}` create rule). *(Personally verified.)*

---

## Bugs & Reliability

### 🟠 High — Auto-block keyword list is too aggressive, silently loses customers
The abusive-word auto-block list includes ordinary words like "dumb," "stupid," "scam," and "scammer." A customer texting something as normal as "is this a scam?" gets permanently blocked platform-wide with no easy way back in. This risks quietly losing real leads. File: `app/api/send-sms/twilio/inbound/route.ts`.

### 🟡 Medium — Follow-up cron has no protection against overlapping runs
If the scheduled job ever fires twice at once (retry, manual trigger overlap), the same pending follow-up could be read and sent twice before either run marks it complete — a customer gets duplicate texts. File: `app/api/cron/send-followups/route.ts`.

### 🟡 Medium — Email blast has no protection against a retried request double-sending
If a network retry causes the same send request to hit the server twice, every recipient in that batch gets the email twice. File: `app/api/send-email-blast/route.ts`.

---

## Data Integrity & Performance

### 🟡 Medium — Blacklisted page loads unbounded data
The page opens live connections to the entire blocked-numbers list and the entire replies collection with no limit — for an active account with thousands of blocked numbers, this loads everything at once on every visit. File: `app/blacklisted/page.tsx`.

### 🟡 Medium — No cap on creating new sending emails
SendGrid allows only 100 sender identities per account total. Nothing currently stops repeated clicks or a bug from burning through that shared limit and blocking other reps from setting up their sending email. File: `app/api/email-marketing/create-sender/route.ts`.

### 🟢 Low — Admin phone lookup can trigger a full account-wide scan
A superadmin diagnostic tool's fallback path scans the entire conversations collection unpaginated when a quick lookup fails. Read-only and admin-only, but gets slower as the account base grows. File: `app/api/admin/diagnose-followups/route.ts`.

---

## Dead Code & Cleanup

### 🟢 Low — Delete unused sender-verification route
`app/api/email-marketing/verify-sender/route.ts` is no longer called anywhere — the current page uses a different route. Safe to delete.

### 🟢 Low — Remove leftover "Email Marketing coming soon" popups
Five pages (`dashboard`, `blacklisted`, `help`, `logs`, `stats`) still carry unused popup code from before Email Marketing was built. Nothing triggers it anymore; safe to remove.

### 🟠 High — Delete duplicate, unused bulk-send route
`app/api/send-sms/twilio/route.ts` is a second, slightly different copy of the same bulk-send logic that nothing in the app actually calls (the real one is `/api/send-sms`). Having two parallel copies is a real risk — a future fix to one won't apply to the other, and someone could accidentally edit the wrong one.

---

## UX Gaps
*(No new items surfaced this pass — prior UX work across dashboard, replies, and thread pages holds up.)*

---

## Architecture / Scale (larger, ongoing items)

### 🟠 High — Full-stack review for scaling to 1,000 accounts
Never completed. Several items above (unbounded blacklist reads, unpaginated admin scans, cron overlap risk) all point to query patterns that are fine today but get riskier as the account count grows.

### 🟡 Medium — Thread page pagination needs a second attempt
First rewrite regressed and was reverted; a root-cause-informed second attempt was never done.

### 🟡 Medium — "Thread page never goes live" report still unresolved
Unreproduced report that a conversation thread page can fail to load or update live for a user.

### 🟡 Medium — Confirm push notifications work end-to-end
Built and wired in, but full delivery (token → notification, on real devices) has never been confirmed working.

### 🟢 Low — Audit scope of past duplicate resends
The bug that could cause duplicate resends was fixed, but whether it actually caused duplicates for real customers before the fix was never checked.

---

**Files confirmed in solid shape this pass (no new issues):** `lib/twilioSend.ts`, `lib/emailSend.ts`, `lib/sendgridSenderIdentity.ts`, `lib/firebaseAdmin.ts`, `lib/firebase.ts`, `lib/globalBlocklist.ts`, `lib/phone.ts`, `lib/date.ts`, `lib/deletionLog.ts`, `lib/twilioErrorCodes.ts`, the Twilio status webhook, `schedule-follow-up` route, all `admin/*` API routes and pages, `templates`, `help`, and shared components.
