"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../lib/firebase";
import { toE164 } from "../lib/phone";
import {
  dismissCallError,
  hangUp,
  isVoiceAvailable,
  startCall,
  subscribeCall,
  warmUpVoice,
  type CallState,
} from "../lib/voiceClient";

// Power dialer for the leads list. Works through the list in order, one call
// at a time: when a call ends (answered, no answer or failed) it waits a few
// seconds - cancellable - and dials the next number.
//
// "Smart" parts: opted-out / blocked numbers, invalid numbers and duplicates
// are screened out before dialing starts; it only dials during 11:00-21:00
// US Eastern (inside 8am-9pm in every continental US time zone); it stops by
// itself on microphone / account errors; pause, skip and stop are always one
// click away.

export type DialLead = { id: string; name?: string; phone: string; status?: string };
export type DialOutcome = "answered" | "no answer" | "failed" | "skipped";
export type DialProgress = {
  currentId: string;
  outcomes: Record<string, DialOutcome>;
  active: boolean;
};

const GAP_SECONDS = 5;

function easternHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  return h === 24 ? 0 : h;
}

function withinCallingHours() {
  const h = easternHour();
  return h >= 11 && h < 21;
}

function skipStatus(status?: string) {
  return /invalid|blocked|opted|duplicate/i.test(String(status || ""));
}

type Props = {
  leads: DialLead[];
  onProgress?: (p: DialProgress) => void;
};

export default function AutoDialer({ leads, onProgress }: Props) {
  const [available, setAvailable] = useState(false);
  const [call, setCall] = useState<CallState | null>(null);
  const [run, setRun] = useState<"off" | "dialing" | "gap" | "paused" | "done">("off");
  const [paused, setPaused] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [currentId, setCurrentId] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, DialOutcome>>({});
  const [note, setNote] = useState("");
  const [screening, setScreening] = useState(false);

  const queueRef = useRef<DialLead[]>([]);
  const posRef = useRef(-1);
  const runRef = useRef<"off" | "dialing" | "gap" | "paused" | "done">("off");
  const pausedRef = useRef(false);
  const reachedRef = useRef(false);
  const outcomesRef = useRef<Record<string, DialOutcome>>({});
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentRef = useRef("");
  const skipRef = useRef(false);

  useEffect(() => {
    let alive = true;
    isVoiceAvailable().then((ok) => {
      if (!alive) return;
      setAvailable(ok);
      if (ok) void warmUpVoice();
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    onProgress?.({
      currentId,
      outcomes,
      active: run === "dialing" || run === "gap" || run === "paused",
    });
  }, [currentId, outcomes, run, onProgress]);

  const setRunState = useCallback((s: "off" | "dialing" | "gap" | "paused" | "done") => {
    runRef.current = s;
    setRun(s);
  }, []);

  const record = useCallback((id: string, outcome: DialOutcome) => {
    outcomesRef.current = { ...outcomesRef.current, [id]: outcome };
    setOutcomes(outcomesRef.current);
  }, []);

  const clearTick = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  };

  const finish = useCallback(
    (message: string) => {
      clearTick();
      currentRef.current = "";
      setCurrentId("");
      setCountdown(0);
      setNote(message);
      setRunState("done");
    },
    [setRunState]
  );

  const dialNext = useCallback(() => {
    clearTick();
    if (runRef.current === "off" || runRef.current === "done") return;

    let next: DialLead | null = null;
    while (posRef.current + 1 < queueRef.current.length) {
      posRef.current += 1;
      const candidate = queueRef.current[posRef.current];
      if (!outcomesRef.current[candidate.id]) {
        next = candidate;
        break;
      }
    }

    if (!next) {
      finish("Finished - no more numbers in this list.");
      return;
    }

    if (!withinCallingHours()) {
      posRef.current -= 1;
      setRunState("paused");
      pausedRef.current = true;
      setPaused(true);
      setNote("Outside calling hours (11:00-21:00 US Eastern). Resume when the window opens.");
      return;
    }

    currentRef.current = next.id;
    setCurrentId(next.id);
    reachedRef.current = false;
    skipRef.current = false;
    setNote("");
    setRunState("dialing");
    void startCall(toE164(next.phone));
  }, [finish, setRunState]);

  const beginGap = useCallback(() => {
    clearTick();
    setRunState("gap");
    let left = GAP_SECONDS;
    setCountdown(left);
    tickRef.current = setInterval(() => {
      if (pausedRef.current) return;
      left -= 1;
      setCountdown(left);
      if (left <= 0) {
        clearTick();
        dialNext();
      }
    }, 1000);
  }, [dialNext, setRunState]);

  // Watch the shared call state and react when the dialed call ends.
  useEffect(() => {
    return subscribeCall((s) => {
      setCall(s);
      if (runRef.current !== "dialing") return;

      if (s.status === "in-call") reachedRef.current = true;

      if (s.status === "idle" && skipRef.current) {
        skipRef.current = false;
        record(currentRef.current, "skipped");
        beginGap();
      } else if (s.status === "ended") {
        const skippedNow = skipRef.current;
        skipRef.current = false;
        record(
          currentRef.current,
          skippedNow ? "skipped" : reachedRef.current ? "answered" : "no answer"
        );
        if (pausedRef.current) {
          setRunState("paused");
        } else {
          beginGap();
        }
      } else if (s.status === "error") {
        record(currentRef.current, "failed");
        if (/microphone|not enabled|not configured|could not start calling/i.test(s.error)) {
          dismissCallError();
          finish(s.error || "Auto-dial stopped.");
        } else if (pausedRef.current) {
          setRunState("paused");
        } else {
          beginGap();
        }
      }
    });
  }, [beginGap, finish, record, setRunState]);

  useEffect(
    () => () => {
      clearTick();
    },
    []
  );

  async function start() {
    if (screening) return;
    if (!withinCallingHours()) {
      setNote("Auto-dial runs 11:00-21:00 US Eastern so every US time zone is within 8am-9pm.");
      return;
    }

    setScreening(true);
    setNote("Checking the list...");
    outcomesRef.current = {};
    setOutcomes({});

    const seen = new Set<string>();
    const queue: DialLead[] = [];
    let invalid = 0;
    for (const lead of leads) {
      const phone = toE164(String(lead.phone || ""));
      if (!/^\+\d{8,15}$/.test(phone) || skipStatus(lead.status) || seen.has(phone)) {
        invalid += 1;
        outcomesRef.current[lead.id] = "skipped";
        continue;
      }
      seen.add(phone);
      queue.push(lead);
    }

    let blockedCount = 0;
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in.");
      const idToken = await user.getIdToken();
      const res = await fetch("/api/voice/screen", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phones: queue.map((l) => toE164(l.phone)) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) throw new Error(json?.error || "Screening failed.");
      const blocked = new Set<string>(json.blocked || []);
      for (const lead of queue) {
        if (blocked.has(toE164(lead.phone))) {
          outcomesRef.current[lead.id] = "skipped";
          blockedCount += 1;
        }
      }
    } catch (e: any) {
      setScreening(false);
      setNote(e?.message || "Could not check the list. Auto-dial not started.");
      return;
    }

    setOutcomes({ ...outcomesRef.current });
    queueRef.current = queue;
    posRef.current = -1;
    pausedRef.current = false;
    setPaused(false);
    setScreening(false);

    const dialable = queue.filter((l) => !outcomesRef.current[l.id]).length;
    if (dialable === 0) {
      finish("Nothing to dial - every number was skipped.");
      return;
    }

    setNote(
      `Skipping ${invalid + blockedCount} number(s) (invalid, duplicate or opted out).`
    );
    setRunState("dialing");
    dialNext();
  }

  function stop() {
    clearTick();
    const wasDialing = runRef.current === "dialing";
    setRunState("off");
    currentRef.current = "";
    setCurrentId("");
    setCountdown(0);
    pausedRef.current = false;
    setPaused(false);
    setNote("Auto-dial stopped.");
    if (wasDialing) hangUp();
  }

  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      if (runRef.current === "gap") setNote("Paused.");
    } else {
      setNote("");
      if (runRef.current === "paused") dialNext();
    }
  }

  function skip() {
    if (runRef.current === "dialing") {
      skipRef.current = true;
      hangUp();
    } else if (runRef.current === "gap") {
      clearTick();
      dialNext();
    }
  }

  if (!available) return null;

  const queue = queueRef.current;
  const counts = Object.values(outcomes);
  const answered = counts.filter((o) => o === "answered").length;
  const noAnswer = counts.filter((o) => o === "no answer").length;
  const skipped = counts.filter((o) => o === "skipped").length;
  const total = queue.length;
  const doneCount = queue.filter((l) => outcomes[l.id]).length;
  const active = run === "dialing" || run === "gap" || run === "paused";
  const current = queue.find((l) => l.id === currentId);
  const nextUp = (() => {
    for (let i = Math.max(posRef.current + (run === "gap" ? 1 : 1), 0); i < queue.length; i++) {
      if (!outcomes[queue[i].id]) return queue[i];
    }
    return null;
  })();
  const callBusy = !!call && call.status !== "idle" && !active;

  const box: React.CSSProperties = {
    border: "1px solid rgba(34,197,94,0.35)",
    background: "rgba(34,197,94,0.07)",
    borderRadius: 14,
    padding: "14px 16px",
    marginBottom: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };
  const btn = (bg: string, color = "#fff"): React.CSSProperties => ({
    background: bg,
    color,
    border: "none",
    borderRadius: 10,
    padding: "9px 16px",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  });

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>Auto-dial</strong>
        {!active ? (
          <button
            onClick={start}
            disabled={screening || callBusy || leads.length === 0}
            style={{
              ...btn("linear-gradient(135deg,#22c55e,#16a34a)"),
              opacity: screening || callBusy || leads.length === 0 ? 0.5 : 1,
            }}
          >
            {screening ? "Checking list..." : "Start auto-dial"}
          </button>
        ) : (
          <>
            <button onClick={togglePause} style={btn("#475569")}>
              {paused ? "Resume" : "Pause after this call"}
            </button>
            <button onClick={skip} style={btn("#334155")}>
              Skip
            </button>
            <button onClick={stop} style={btn("#dc2626")}>
              Stop
            </button>
          </>
        )}
        <span style={{ fontSize: 13, opacity: 0.8 }}>
          {total > 0 ? `${doneCount}/${total} done` : `${leads.length} leads in list`}
          {total > 0 ? ` · ${answered} answered · ${noAnswer} no answer · ${skipped} skipped` : ""}
        </span>
      </div>

      {active && (
        <div style={{ fontSize: 14 }}>
          {run === "dialing" && current && (
            <span>
              Calling <strong>{current.name || "-"}</strong> {current.phone}
              {call?.status === "in-call" ? " - connected" : call?.status === "ringing" ? " - ringing" : ""}
            </span>
          )}
          {run === "gap" && !paused && (
            <span
              style={{
                display: "inline-block",
                background: "rgba(34,197,94,0.18)",
                border: "1px solid rgba(34,197,94,0.5)",
                borderRadius: 10,
                padding: "8px 14px",
                fontSize: 16,
              }}
            >
              Next call in <strong style={{ fontSize: 20 }}>{countdown}s</strong>
              {nextUp ? ` - ${nextUp.name || "-"} ${nextUp.phone}` : ""}
            </span>
          )}
          {paused && run !== "dialing" && <span>Paused. Press Resume to continue.</span>}
          {paused && run === "dialing" && <span> (will pause after this call)</span>}
        </div>
      )}

      {note && <div style={{ fontSize: 13, opacity: 0.85 }}>{note}</div>}
      <div style={{ fontSize: 12, opacity: 0.6 }}>
        Dials in list order, one at a time. Hang up to move to the next lead. Opted-out numbers are
        skipped. Runs 11:00-21:00 US Eastern. Keep this tab open.
      </div>
    </div>
  );
}
