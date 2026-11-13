import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "../../../../lib/firebaseAdmin";
import { toE164 } from "../../../../lib/phone";

// Pre-flight check for the dialer queue: given a list of numbers, returns the
// ones that must not be called (platform-wide opt-outs and this account's own
// blocked numbers) so the queue can skip them up front. The TwiML route still
// enforces the same rules at dial time.

const MAX_PHONES = 5000;

async function getUid(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) throw new Error("Missing authorization token.");
  return (await getAuth().verifyIdToken(token)).uid;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const uid = await getUid(req);
    const body = await req.json().catch(() => ({}));
    const input: unknown[] = Array.isArray(body?.phones) ? body.phones : [];

    const phones = Array.from(
      new Set(
        input
          .slice(0, MAX_PHONES)
          .map((p) => toE164(String(p || "")))
          .filter((p) => /^\+\d{8,15}$/.test(p))
      )
    );

    const blocked = new Set<string>();

    for (const part of chunk(phones, 30)) {
      const [globalSnap, ownerSnap] = await Promise.all([
        adminDb.collection("globalBlacklist").where("phone", "in", part).get(),
        adminDb
          .collection("blacklisted_numbers")
          .where("ownerUid", "==", uid)
          .where("phone", "in", part)
          .get(),
      ]);

      globalSnap.docs.forEach((d) => {
        const data = d.data() || {};
        if (String(data.status || "").toLowerCase() === "blocked") {
          blocked.add(String(data.phone || d.id));
        }
      });
      ownerSnap.docs.forEach((d) => {
        const data = d.data() || {};
        if (String(data.status || "").toLowerCase() === "blocked") {
          blocked.add(String(data.phone || ""));
        }
      });
    }

    return NextResponse.json({ ok: true, blocked: Array.from(blocked) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
