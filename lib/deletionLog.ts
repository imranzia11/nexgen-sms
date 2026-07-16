import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase";

// A permanent, append-only audit trail of every manual delete a signed-in
// user performs (a conversation/number from Replies, a single lead from an
// uploaded file, or an upload file record itself). Written client-side at
// the same moment as the real deleteDoc() call, using whatever the caller
// already has in memory about the thing being deleted - by the time this
// runs the document is already gone, so there is no way to reconstruct
// "what got deleted" after the fact without this.
//
// Deliberately best-effort: a failure to write the log entry must never
// surface as a failure of the deletion itself (the thing the user actually
// asked for). Callers should call this with `void logDeletion(...)` right
// after their deleteDoc() succeeds and not await/block on it.
//
// Firestore rules only allow `create` on this collection (see
// firestore.rules) - no update, no delete - so once written, an entry
// can't be edited or erased through the app, keeping it a trustworthy
// record of who deleted what and when.

export type DeletionType = "conversation" | "lead" | "upload_record";

export async function logDeletion(entry: {
  type: DeletionType;
  phone?: string;
  name?: string;
  fileName?: string;
  source: string;
}): Promise<void> {
  try {
    const user = auth.currentUser;
    if (!user) return;

    await addDoc(collection(db, "deletionLogs"), {
      ownerUid: user.uid,
      ownerEmail: user.email || "",
      type: entry.type,
      phone: entry.phone || "",
      name: entry.name || "",
      fileName: entry.fileName || "",
      source: entry.source,
      deletedAt: serverTimestamp(),
    });
  } catch (error) {
    console.error("Failed to write deletion log (non-fatal)", error);
  }
}
