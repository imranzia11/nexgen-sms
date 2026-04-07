import * as admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

const TARGET_EMAIL = "abe@nexgen.io";
const TARGET_TWILIO_NUMBER = "+16625688815";

function normalizePhone(value: string) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function isWaitingConversation(data: Record<string, any>) {
  const lastDirection = String(data.lastDirection || "").trim().toLowerCase();
  const status = String(data.status || "").trim().toLowerCase();

  if (lastDirection === "outbound") return true;
  if (status === "awaiting_reply") return true;
  if (status === "waiting_for_customer") return true;

  return false;
}

async function getTargetUser() {
  const snap = await db
    .collection("users")
    .where("email", "==", TARGET_EMAIL)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new Error(`User not found for email ${TARGET_EMAIL}`);
  }

  const doc = snap.docs[0];
  const data = doc.data() || {};

  return {
    uid: doc.id,
    email: String(data.email || TARGET_EMAIL),
    name: String(data.name || ""),
    twilioNumber: normalizePhone(
      String(data.twilioNumber || data.assignedTwilioNumber || TARGET_TWILIO_NUMBER)
    ),
  };
}

async function deleteCollectionDocs(
  collectionPath: string,
  batchSize = 200
): Promise<number> {
  let deleted = 0;

  while (true) {
    const snap = await db.collection(collectionPath).limit(batchSize).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    deleted += snap.docs.length;

    if (snap.size < batchSize) break;
  }

  return deleted;
}

async function deleteQueryDocs(
  queryRef: FirebaseFirestore.Query,
  batchSize = 200
): Promise<number> {
  let deleted = 0;

  while (true) {
    const snap = await queryRef.limit(batchSize).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    deleted += snap.docs.length;

    if (snap.size < batchSize) break;
  }

  return deleted;
}

async function main() {
  console.log("Starting delete script...");

  const targetUser = await getTargetUser();
  console.log("Target user:", targetUser);

  const convoSnap = await db
    .collection("conversations")
    .where("ownerUid", "==", targetUser.uid)
    .get();

  const waitingConversations = convoSnap.docs.filter((doc) => {
    const data = doc.data() || {};
    const phone = normalizePhone(String(data.phone || ""));
    const twilioNumber = normalizePhone(
      String(data.twilioNumber || data.assignedTwilioNumber || "")
    );

    const belongsToUser =
      String(data.ownerUid || "") === targetUser.uid &&
      (!targetUser.twilioNumber || !twilioNumber || twilioNumber === targetUser.twilioNumber);

    return belongsToUser && isWaitingConversation(data) && !!phone;
  });

  console.log(`Found ${waitingConversations.length} waiting conversations to delete.`);

  let deletedConversationCount = 0;
  let deletedThreadMessages = 0;
  let deletedRootMessages = 0;
  let deletedReplies = 0;

  for (const convoDoc of waitingConversations) {
    const convoId = convoDoc.id;
    const convoData = convoDoc.data() || {};
    const phone = normalizePhone(String(convoData.phone || ""));

    console.log(`Deleting conversation ${convoId} (${phone})...`);

    deletedThreadMessages += await deleteCollectionDocs(
      `conversations/${convoId}/messages`
    );

    deletedRootMessages += await deleteQueryDocs(
      db
        .collection("messages")
        .where("conversationId", "==", convoId)
    );

    deletedReplies += await deleteQueryDocs(
      db
        .collection("replies")
        .where("conversationId", "==", convoId)
    );

    await convoDoc.ref.delete();
    deletedConversationCount += 1;
  }

  console.log("Delete completed.");
  console.log("Deleted conversations:", deletedConversationCount);
  console.log("Deleted thread messages:", deletedThreadMessages);
  console.log("Deleted root messages:", deletedRootMessages);
  console.log("Deleted replies:", deletedReplies);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Delete failed:", err);
    process.exit(1);
  });