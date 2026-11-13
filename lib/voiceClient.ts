"use client";

import { auth } from "./firebase";

// Browser-side calling. One shared Twilio Voice Device per tab, so every
// call icon on a page drives the same call bar. The Voice SDK is loaded on
// first use (it needs `window`/WebRTC and shouldn't weigh down pages that
// never place a call).

export type CallStatus = "idle" | "connecting" | "ringing" | "in-call" | "ended" | "error";

export type CallState = {
  status: CallStatus;
  to: string;
  muted: boolean;
  seconds: number;
  error: string;
};

const initialState: CallState = { status: "idle", to: "", muted: false, seconds: 0, error: "" };

let state: CallState = initialState;
const listeners = new Set<(s: CallState) => void>();

let device: any = null;
let activeCall: any = null;
let timer: ReturnType<typeof setInterval> | null = null;
let availability: Promise<boolean> | null = null;
let cachedToken: { token: string; at: number } | null = null;

function setState(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function subscribeCall(listener: (s: CallState) => void) {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

async function fetchToken(): Promise<{ enabled: boolean; token?: string }> {
  const user = auth.currentUser;
  if (!user) return { enabled: false };
  const idToken = await user.getIdToken();
  const res = await fetch("/api/voice/token", {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || "Could not start calling.");
  }
  if (json.enabled !== true) return { enabled: false };
  cachedToken = { token: json.token, at: Date.now() };
  return { enabled: true, token: json.token };
}

// Whether calling is switched on for the signed-in account. Cached per tab.
export function isVoiceAvailable(): Promise<boolean> {
  if (!availability) {
    availability = fetchToken()
      .then((r) => r.enabled)
      .catch(() => false);
  }
  return availability;
}

async function ensureDevice() {
  if (device) return device;

  const tokenResult =
    cachedToken && Date.now() - cachedToken.at < 50 * 60 * 1000
      ? { enabled: true, token: cachedToken.token }
      : await fetchToken();
  if (!tokenResult.enabled || !tokenResult.token) {
    throw new Error("Calling is not enabled for this account.");
  }

  const { Device } = await import("@twilio/voice-sdk");
  device = new Device(tokenResult.token, {
    codecPreferences: ["opus", "pcmu"] as any,
    closeProtection: true,
  });

  // Keep the token fresh for long sessions.
  device.on("tokenWillExpire", async () => {
    try {
      const fresh = await fetchToken();
      if (fresh.token) device.updateToken(fresh.token);
    } catch {
      /* the next call attempt will surface a real error */
    }
  });
  device.on("error", (err: any) => {
    setState({ status: "error", error: err?.message || "Calling error." });
  });

  return device;
}

// Loads the Voice SDK and registers the device ahead of the first call so
// the first dial isn't delayed by setup. Errors surface on the real call.
export async function warmUpVoice() {
  try {
    await ensureDevice();
  } catch {
    /* ignored */
  }
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function finishCall() {
  stopTimer();
  activeCall = null;
  setState({ status: "ended", muted: false });
  setTimeout(() => {
    if (state.status === "ended") setState({ ...initialState });
  }, 2500);
}

export async function startCall(to: string) {
  if (activeCall || state.status === "connecting") return;

  try {
    setState({ ...initialState, status: "connecting", to });
    const dev = await ensureDevice();

    // Asks the browser for microphone access the first time.
    const call = await dev.connect({ params: { To: to } });
    activeCall = call;

    call.on("ringing", () => setState({ status: "ringing" }));
    call.on("accept", () => {
      setState({ status: "in-call", seconds: 0 });
      stopTimer();
      timer = setInterval(() => setState({ seconds: state.seconds + 1 }), 1000);
    });
    call.on("disconnect", finishCall);
    call.on("cancel", finishCall);
    call.on("reject", finishCall);
    call.on("error", (err: any) => {
      stopTimer();
      activeCall = null;
      setState({ status: "error", error: err?.message || "The call failed." });
    });
  } catch (error: any) {
    activeCall = null;
    const denied = /permission|denied|NotAllowed/i.test(String(error?.message || error));
    setState({
      status: "error",
      error: denied
        ? "Microphone access is blocked. Allow the microphone and try again."
        : error?.message || "Could not start the call.",
    });
  }
}

export function hangUp() {
  if (activeCall) {
    activeCall.disconnect();
  } else {
    setState({ ...initialState });
  }
}

export function toggleMute() {
  if (!activeCall) return;
  const next = !state.muted;
  activeCall.mute(next);
  setState({ muted: next });
}

export function dismissCallError() {
  setState({ ...initialState });
}
