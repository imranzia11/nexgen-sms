// Rebuilds an account's message history (sent AND received) from Twilio's own
// message log, for when the Firestore records were lost - e.g. an account was
// deleted and re-created. Creates conversations + messages under the account's
// CURRENT uid, shaped like the ones the app writes itself.
//
// Safe to re-run: messages already present (matched by Twilio SID) are skipped,
// and each conversation's counters are recomputed from what is stored.
//
// Usage:
//   npx tsx tools/recover-from-twilio.ts --email=jon@nexgenmerchant.io            (dry run)
//   npx tsx tools/recover-from-twilio.ts --email=jon@nexgenmerchant.io --apply
//   optional: --since=2026-01-01   only messages sent on/after this date
//
// Needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env.local (already there).
// Recovered threads are marked read (no unread badge flood).

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const email = getArg("email").trim().toLowerCase();
  const since = getArg("since").trim();
  if (!email) {
    console.error("Usage: --email=user@example.com [--since=YYYY-MM-DD] [--apply]");
    process.exit(1);
  }

  const { adminDb } = await import("../lib/firebaseAdmin");
  const { toE164, phoneDocId, reversePhone } = await import("../lib/phone");
  const twilio = (await import("twilio")).default;
  const { FieldValue } = await import("firebase-admin/firestore");

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing in .env.local");
    process.exit(1);
  }
  const client = twilio(sid, token);

  // Resolve the uid from Firebase Authentication so a leftover profile from a
  // deleted login with the same email can never be picked by mistake.
  const { getAuth } = await import("firebase-admin/auth");
  let uid = "";
  try {
    uid = (await getAuth().getUserByEmail(email)).uid;
  } catch {
    console.error(`No login exists in Firebase Authentication for ${email}.`);
    process.exit(1);
  }
  const userDoc = await adminDb.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    console.error(`Login exists but users/${uid} profile is missing.`);
    process.exit(1);
  }
  const user = userDoc.data() || {};
  const number = toE164(String(user.twilioNumber || user.assignedTwilioNumber || ""));
  if (!number) {
    console.error("That account has no Twilio number.");
    process.exit(1);
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Account: ${email} (uid ${uid}), number ${number}${since ? `, since ${since}` : ""}\n`);

  const dateFilter = since ? { dateSentAfter: new Date(`${since}T00:00:00Z`) } : {};
  console.log("Reading Twilio message log (this can take a while)...");
  const [sent, received] = await Promise.all([
    client.messages.list({ from: number, ...dateFilter }),
    client.messages.list({ to: number, ...dateFilter }),
  ]);
  console.log(`Twilio: ${sent.length} sent, ${received.length} received.\n`);

  type Msg = {
    sid: string;
    direction: "outbound" | "inbound";
    phone: string;
    body: string;
    status: string;
    numMedia: number;
    errorCode: string;
    at: Date;
  };

  const all: Msg[] = [];
  for (const m of sent) {
    all.push({
      sid: m.sid,
      direction: "outbound",
      phone: toE164(String(m.to || "")),
      body: String(m.body || ""),
      status: String(m.status || ""),
      numMedia: Number(m.numMedia || 0),
      errorCode: m.errorCode ? String(m.errorCode) : "",
      at: m.dateSent || m.dateCreated || new Date(),
    });
  }
  for (const m of received) {
    all.push({
      sid: m.sid,
      direction: "inbound",
      phone: toE164(String(m.from || "")),
      body: String(m.body || ""),
      status: String(m.status || "received"),
      numMedia: Number(m.numMedia || 0),
      errorCode: "",
      at: m.dateSent || m.dateCreated || new Date(),
    });
  }

  const byPhone = new Map<string, Msg[]>();
  for (const m of all) {
    if (!/^\+\d{8,15}$/.test(m.phone)) continue;
    const list = byPhone.get(m.phone) || [];
    list.push(m);
    byPhone.set(m.phone, list);
  }
  console.log(`${all.length} messages across ${byPhone.size} conversation(s).`);
  if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply.");
    return;
  }

  let convoCount = 0;
  let newMsgs = 0;
  for (const [phone, msgs] of byPhone) {
    msgs.sort((a, b) => a.at.getTime() - b.at.getTime());
    const conversationId = `${uid}_${phoneDocId(phone)}`;
    const convoRef = adminDb.collection("conversations").doc(conversationId);

    // Which of these are already stored?
    const existing = await convoRef.collection("messages").select("sid").get();
    const have = new Set(existing.docs.map((d) => d.id));

    let batch = adminDb.batch();
    let ops = 0;
    for (const m of msgs) {
      if (have.has(m.sid)) continue;
      const base = {
        sid: m.sid,
        twilioSid: m.sid,
        ownerUid: uid,
        ownerEmail: String(user.email || ""),
        ownerName: String(user.name || ""),
        ownerRole: String(user.role || "user"),
        conversationId,
        phone,
        from: m.direction === "outbound" ? number : phone,
        to: m.direction === "outbound" ? phone : number,
        body: m.body,
        mediaUrls: [] as string[],
        numMedia: m.numMedia,
        direction: m.direction,
        status: m.status,
        read: true,
        twilioNumber: number,
        assignedTwilioNumber: number,
        error: m.errorCode,
        recoveredFromTwilio: true,
        createdAt: m.at,
        updatedAt: m.at,
      };
      batch.set(convoRef.collection("messages").doc(m.sid), base);
      batch.set(adminDb.collection("messages").doc(`recovered_${m.sid}`), base);
      ops += 2;
      newMsgs += 1;
      if (ops >= 400) {
        await batch.commit();
        batch = adminDb.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    // Recompute the conversation summary from everything stored.
    const stored = await convoRef.collection("messages").get();
    const rows = stored.docs
      .map((d) => d.data())
      .map((d) => ({
        direction: String(d.direction),
        body: String(d.body || ""),
        status: String(d.status || ""),
        at: (d.createdAt?.toDate ? d.createdAt.toDate() : new Date(d.createdAt)) as Date,
      }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const outbound = rows.filter((r) => r.direction === "outbound");
    const inbound = rows.filter((r) => r.direction === "inbound");
    const last = rows[rows.length - 1];
    const hasReply = inbound.length > 0;

    const convoSnap = await convoRef.get();
    const prev = convoSnap.exists ? convoSnap.data() || {} : {};

    await convoRef.set(
      {
        ownerUid: uid,
        ownerEmail: String(user.email || ""),
        ownerName: String(user.name || ""),
        ownerRole: String(user.role || "user"),
        phone,
        phoneReversed: reversePhone(phone),
        name: String(prev.name || ""),
        twilioNumber: number,
        assignedTwilioNumber: number,
        lastMessage: last?.body || "",
        lastDirection: last?.direction || "outbound",
        lastMessageAt: last?.at || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: hasReply ? "replied" : "awaiting_reply",
        hasReply,
        unreadCount: Number(prev.unreadCount || 0),
        replyCount: inbound.length,
        outboundCount: outbound.length,
        messageCount: rows.length,
        firstOutboundAt: outbound[0]?.at || null,
        lastOutboundAt: outbound[outbound.length - 1]?.at || null,
        lastInboundAt: inbound[inbound.length - 1]?.at || null,
        lastOutboundStatus: outbound[outbound.length - 1]?.status || "",
        blocked: prev.blocked === true,
      },
      { merge: true }
    );

    convoCount += 1;
    if (convoCount % 200 === 0) console.log(`  ...${convoCount}/${byPhone.size} conversations`);
  }

  console.log(`\nDone. ${newMsgs} message(s) added across ${convoCount} conversation(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
