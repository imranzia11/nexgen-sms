import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { toE164 } from "./phone";

// Shared by the superadmin route and the account-holder route.
// An account's TEXT number is fixed; its CALLING number (users/{uid}.callNumber)
// is optional and defaults to the text number when empty.

type TwilioNumber = { phone_number?: string; friendly_name?: string };

function twilioAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new HttpError("Missing Twilio configuration.", 500);
  return { sid, header: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Twilio numbers nobody uses for texting or calling.
export async function listFreeNumbers(): Promise<{ phoneNumber: string; friendlyName: string }[]> {
  const { sid, header } = twilioAuth();
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=1000`,
    { headers: { Authorization: header }, cache: "no-store" }
  );
  const body = (await res.json().catch(() => ({}))) as {
    incoming_phone_numbers?: TwilioNumber[];
    message?: string;
  };
  if (!res.ok) throw new HttpError(body.message || "Failed to load numbers.", 502);

  const [textSnap, callSnap, usersSnap] = await Promise.all([
    adminDb.collection("numberAssignments").get(),
    adminDb.collection("callNumberAssignments").get(),
    adminDb.collection("users").where("isActive", "==", true).get(),
  ]);
  const taken = new Set<string>();
  textSnap.docs.forEach((d) => taken.add(toE164(d.id)));
  callSnap.docs.forEach((d) => taken.add(toE164(d.id)));
  usersSnap.docs.forEach((d) => {
    const u = d.data() || {};
    const a = toE164(String(u.twilioNumber || u.assignedTwilioNumber || ""));
    const c = toE164(String(u.callNumber || ""));
    if (a) taken.add(a);
    if (c) taken.add(c);
  });

  return (body.incoming_phone_numbers || [])
    .map((n) => ({
      phoneNumber: toE164(String(n.phone_number || "")),
      friendlyName: String(n.friendly_name || n.phone_number || ""),
    }))
    .filter((n) => n.phoneNumber && !taken.has(n.phoneNumber))
    .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));
}

// Set (or clear with "") the calling number of an active account.
export async function setCallNumber(uid: string, raw: string, updatedBy: string) {
  const wanted = raw.trim() ? toE164(raw) : "";
  if (wanted && !/^\+\d{8,15}$/.test(wanted)) {
    throw new HttpError("Select a valid Twilio number.", 400);
  }

  const targetRef = adminDb.collection("users").doc(uid);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpError("Account not found.", 404);
  const target = targetSnap.data() || {};
  if (String(target.role || "").toLowerCase() === "superadmin") {
    throw new HttpError("Superadmin accounts can't be changed here.", 400);
  }
  if (target.isActive !== true) throw new HttpError("Account is not active.", 400);

  const smsNumber = toE164(String(target.twilioNumber || target.assignedTwilioNumber || ""));
  const current = toE164(String(target.callNumber || ""));
  const effective = wanted === smsNumber ? "" : wanted;
  if (effective === current) {
    return { callNumber: current, dialsFrom: current || smsNumber, releasedNumber: "" };
  }

  if (effective) {
    const { sid, header } = twilioAuth();
    const check = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
        effective
      )}`,
      { headers: { Authorization: header }, cache: "no-store" }
    );
    const checkBody = (await check.json().catch(() => ({}))) as {
      incoming_phone_numbers?: unknown[];
    };
    if (!check.ok || !(checkBody.incoming_phone_numbers || []).length) {
      throw new HttpError("That number isn't on the Twilio account.", 400);
    }
    const textTaken = await adminDb.collection("numberAssignments").doc(effective).get();
    if (textTaken.exists) throw new HttpError("That number is already in use.", 409);
    try {
      await adminDb
        .collection("callNumberAssignments")
        .doc(effective)
        .create({ ownerUid: uid, createdAt: new Date() });
    } catch {
      throw new HttpError("That number is already in use.", 409);
    }
  }

  try {
    await targetRef.set(
      {
        callNumber: effective,
        statusUpdatedAt: FieldValue.serverTimestamp(),
        statusUpdatedBy: updatedBy,
      },
      { merge: true }
    );
  } catch (e) {
    if (effective) {
      await adminDb.collection("callNumberAssignments").doc(effective).delete().catch(() => {});
    }
    throw e;
  }

  if (current) {
    const oldRef = adminDb.collection("callNumberAssignments").doc(current);
    const oldSnap = await oldRef.get();
    if (oldSnap.exists && oldSnap.data()?.ownerUid === uid) await oldRef.delete();
  }

  return { callNumber: effective, dialsFrom: effective || smsNumber, releasedNumber: current };
}
