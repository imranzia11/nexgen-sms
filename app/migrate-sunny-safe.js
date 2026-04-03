const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const SUNNY_UID = "SKmaVTN8TjeTayQ9FiuStmNiNLE2";
const SUNNY_NAME = "sunny";
const SUNNY_EMAIL = "sunnyadminsms@nexgen.io";
const SUNNY_MESSAGING_SERVICE_SID = "MGd559bff40a3983af5cc49217d66f6875";
const SUNNY_TWILIO_NUMBER = "+19145674441";

async function run() {
  await db.collection("users").doc(SUNNY_UID).set(
    {
      name: SUNNY_NAME,
      email: SUNNY_EMAIL,
      role: "user",
      isActive: true,
      messagingServiceSid: SUNNY_MESSAGING_SERVICE_SID,
      twilioNumber: SUNNY_TWILIO_NUMBER,
    },
    { merge: true }
  );

  async function updateDocs(collectionName, matcher, updater) {
    const snap = await db.collection(collectionName).get();
    let batch = db.batch();
    let count = 0;

    for (const d of snap.docs) {
      const data = d.data();
      if (!matcher(data)) continue;

      batch.update(d.ref, updater(data));

      count++;
      if (count % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }

    await batch.commit();
    console.log(`${collectionName}: done`);
  }

  await updateDocs(
    "conversations",
    (data) =>
      data.messagingServiceSid === SUNNY_MESSAGING_SERVICE_SID ||
      data.twilioNumber === SUNNY_TWILIO_NUMBER,
    () => ({ ownerUid: SUNNY_UID })
  );

  await updateDocs(
    "replies",
    (data) =>
      data.messagingServiceSid === SUNNY_MESSAGING_SERVICE_SID ||
      data.to === SUNNY_TWILIO_NUMBER,
    () => ({ ownerUid: SUNNY_UID })
  );

  await updateDocs(
    "blacklisted_numbers",
    (data) =>
      data.messagingServiceSid === SUNNY_MESSAGING_SERVICE_SID ||
      data.twilioNumber === SUNNY_TWILIO_NUMBER,
    () => ({ ownerUid: SUNNY_UID })
  );

  await updateDocs(
    "blacklist_events",
    (data) =>
      data.messagingServiceSid === SUNNY_MESSAGING_SERVICE_SID ||
      data.to === SUNNY_TWILIO_NUMBER,
    () => ({ ownerUid: SUNNY_UID })
  );

  await updateDocs(
    "uploads",
    (data) =>
      data.uploadedByName === "sunny" ||
      data.uploadedBy === SUNNY_UID,
    () => ({
      uploadedBy: SUNNY_UID,
      uploadedByName: SUNNY_NAME,
    })
  );

  await updateDocs(
    "leads",
    (data) =>
      data.uploadedBy === SUNNY_UID ||
      !!data.sourceFileName,
    () => ({
      uploadedBy: SUNNY_UID,
    })
  );

  console.log("Sunny migration complete");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});