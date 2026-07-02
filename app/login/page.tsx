"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;

      const snap = await getDoc(doc(db, "users", uid));

      if (!snap.exists()) {
        await signOut(auth).catch(() => {});
        setError("User record not found in Firestore.");
        setLoading(false);
        return;
      }

      const data = snap.data();

      if (data.isActive !== true) {
        await signOut(auth).catch(() => {});
        setError("Access denied. Account inactive.");
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch (err: any) {
      setError(err?.message || "Login failed");
    }

    setLoading(false);
  };

  return (
    <main style={page}>
      <div style={bg1} />
      <div style={bg2} />

      <div style={container}>
        {/* LEFT */}
        <div style={left}>
          <div style={brand}>
            ⚡ <span style={{ color: "#6366f1" }}>Nexgen AI</span>
          </div>

          <h1 style={title}>AI SMS Workspace</h1>

          <p style={subtitle}>
            Manage campaigns, leads, and messaging with a clean AI-powered dashboard.
          </p>

          <div style={grid}>
            <Card title="CSV Imports" text="Upload and manage leads instantly." />
            <Card title="AI Campaigns" text="Smart bulk SMS automation." />
            <Card title="Replies Inbox" text="Track customer responses." />
            <Card title="Secure Login" text="Enterprise authentication." />
          </div>
        </div>

        {/* RIGHT */}
        <div style={right}>
          <div style={card}>
            <h2 style={loginTitle}>Sign in</h2>

            <form onSubmit={handleLogin} style={form}>
              <input
                style={input}
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />

              <input
                style={input}
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              {error && <div style={errorBox}>{error}</div>}

              <button style={btn} disabled={loading}>
                {loading ? "Signing in..." : "Login"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}

function Card({ title, text }: any) {
  return (
    <div style={miniCard}>
      <div style={dot} />
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 13, opacity: 0.7 }}>{text}</div>
    </div>
  );
}

/* ================= WHITE AI THEME ================= */

const page: any = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f7f9fc",
  padding: 20,
  position: "relative",
  overflow: "hidden",
};

const bg1: any = {
  position: "absolute",
  width: 320,
  height: 320,
  borderRadius: "50%",
  background: "rgba(99,102,241,0.15)",
  filter: "blur(90px)",
  top: -80,
  left: -80,
};

const bg2: any = {
  position: "absolute",
  width: 320,
  height: 320,
  borderRadius: "50%",
  background: "rgba(16,185,129,0.12)",
  filter: "blur(90px)",
  bottom: -80,
  right: -80,
};

const container: any = {
  position: "relative",
  width: "100%",
  maxWidth: 1100,
  display: "grid",
  gridTemplateColumns: "1.2fr 0.8fr",
  gap: 40,
};

const left: any = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
};

const brand: any = {
  fontSize: 20,
  fontWeight: 800,
};

const title: any = {
  fontSize: 54,
  fontWeight: 900,
  marginTop: 18,
  color: "#0f172a",
};

const subtitle: any = {
  fontSize: 16,
  marginTop: 10,
  color: "#64748b",
  maxWidth: 500,
};

const grid: any = {
  display: "grid",
  gridTemplateColumns: "repeat(2,1fr)",
  gap: 12,
  marginTop: 28,
};

const right: any = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const card: any = {
  width: "100%",
  padding: 32,
  borderRadius: 20,
  background: "white",
  border: "1px solid #eef2f7",
  boxShadow: "0 20px 60px rgba(0,0,0,0.06)",
};

const loginTitle: any = {
  fontSize: 24,
  fontWeight: 800,
  marginBottom: 18,
};

const form: any = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const input: any = {
  padding: 12,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  outline: "none",
  fontSize: 14,
};

const btn: any = {
  marginTop: 10,
  padding: 12,
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(90deg,#3b82f6,#8b5cf6)",
  color: "white",
  fontWeight: 700,
  cursor: "pointer",
};

const errorBox: any = {
  padding: 10,
  borderRadius: 10,
  background: "#fee2e2",
  color: "#991b1b",
  fontSize: 13,
};

const miniCard: any = {
  padding: 14,
  borderRadius: 14,
  background: "white",
  border: "1px solid #eef2f7",
};

const dot: any = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#6366f1",
  marginBottom: 8,
};