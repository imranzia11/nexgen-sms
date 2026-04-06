import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/firebaseAdmin";

async function hasInboundInThread(conversationId: string) {
  const snap = await adminDb
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .where("direction", "==", "inbound")
    .limit(1)
    .get();

  return !snap.empty;
}

async function hasInboundInReplies(ownerUid: string, phone: string) {
  const snap = await adminDb
    .collection("replies")
    .where("ownerUid", "==", ownerUid)
    .where("phone", "==", phone)
    .where("direction", "==", "inbound")
    .limit(1)
    .get();

  return !snap.empty;
}

async function run() {
  const convoSnap = await adminDb.collection("conversations").get();

  console.log(`Found ${convoSnap.size} conversations`);

  let fixed = 0;
  let kept = 0;

  for (const docSnap of convoSnap.docs) {
    const data = docSnap.data() || {};
    const conversationId = docSnap.id;
    const ownerUid = String(data.ownerUid || "").trim();
    const phone = String(data.phone || "").trim();

    if (!ownerUid || !phone) {
      kept++;
      continue;
    }

    const inboundInThread = await hasInboundInThread(conversationId);
    const inboundInReplies = await hasInboundInReplies(ownerUid, phone);
    const hasRealInbound = inboundInThread || inboundInReplies;

    if (hasRealInbound) {
      await docSnap.ref.set(
        {
          hasReply: true,
          status: "replied",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      kept++;
      continue;
    }

    await docSnap.ref.set(
      {
        hasReply: false,
        status: "awaiting_reply",
        replyCount: 0,
        unreadCount: 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    fixed++;
    console.log(`Fixed ${conversationId}`);
  }

  console.log(`Done. Fixed=${fixed}, kept=${kept}`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });