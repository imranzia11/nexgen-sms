"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
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
    <>
      <style jsx global>{`
        @keyframes floatGlow {
          0% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-8px);
          }
          100% {
            transform: translateY(0px);
          }
        }

        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        input::placeholder {
          color: rgba(226, 232, 240, 0.72);
        }
      `}</style>

      <main style={pageStyle}>
        <div style={bgGlowOne} />
        <div style={bgGlowTwo} />

        <div style={shellStyle}>
          <section style={leftStyle}>
            <div style={brandRowStyle}>
              <div style={brandIconStyle}>N</div>
              <div>
                <div style={brandTitleStyle}>Nexgen SMS</div>
                <div style={brandSubStyle}>Portal</div>
              </div>
            </div>

            <div style={heroBadgeStyle}>Premium User Workspace</div>

            <h1 style={heroTitleStyle}>Sign in to your SMS portal</h1>

            <p style={heroTextStyle}>
              Manage imported lead files, launch SMS campaigns, monitor replies,
              and keep your workflow in one premium control center.
            </p>

            <div style={featureGridStyle}>
              <FeatureCard
                title="CSV Imports"
                text="Upload lead files and organize recipients fast."
              />
              <FeatureCard
                title="Bulk SMS"
                text="Launch campaigns from one clean dashboard."
              />
              <FeatureCard
                title="Replies Inbox"
                text="Track incoming customer responses easily."
              />
              <FeatureCard
                title="User Access"
                text="Secure sign-in for active portal users."
              />
            </div>
          </section>

          <section style={rightWrapStyle}>
            <div style={cardStyle}>
              <div style={cardTopStyle}>
                <div style={loginIconWrapStyle}>
                  <div style={loginIconStyle}>↗</div>
                </div>
                <h2 style={cardTitleStyle}>Portal Login</h2>
                <p style={cardTextStyle}>Sign in to continue to Nexgen SMS Portal</p>
              </div>

              <form onSubmit={handleLogin} style={formStyle}>
                <div>
                  <label style={labelStyle}>Email Address</label>
                  <input
                    type="email"
                    placeholder="Enter your email"
                    style={inputStyle}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div>
                  <label style={labelStyle}>Password</label>
                  <input
                    type="password"
                    placeholder="Enter password"
                    style={inputStyle}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {error ? <div style={errorBoxStyle}>{error}</div> : null}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    ...buttonStyle,
                    opacity: loading ? 0.75 : 1,
                    cursor: loading ? "not-allowed" : "pointer",
                  }}
                >
                  {loading ? (
                    <span style={buttonLoadingWrapStyle}>
                      <span style={spinnerStyle} />
                      Logging in...
                    </span>
                  ) : (
                    "Login"
                  )}
                </button>
              </form>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <div style={featureCardStyle}>
      <div style={featureDotStyle} />
      <div style={featureTitleStyle}>{title}</div>
      <div style={featureTextStyle}>{text}</div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  position: "relative",
  overflow: "hidden",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 45%, #14b8a6 100%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px 20px",
};

const bgGlowOne: CSSProperties = {
  position: "absolute",
  width: 420,
  height: 420,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.10)",
  top: -120,
  left: -100,
  filter: "blur(30px)",
};

const bgGlowTwo: CSSProperties = {
  position: "absolute",
  width: 420,
  height: 420,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.08)",
  bottom: -140,
  right: -120,
  filter: "blur(30px)",
};

const shellStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "100%",
  maxWidth: 1280,
  display: "grid",
  gridTemplateColumns: "1.1fr 0.9fr",
  gap: 28,
  alignItems: "stretch",
};

const leftStyle: CSSProperties = {
  padding: "22px 8px",
  color: "#ffffff",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
};

const brandRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const brandIconStyle: CSSProperties = {
  width: 72,
  height: 72,
  borderRadius: 22,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.16)",
  color: "#ffffff",
  fontSize: 34,
  fontWeight: 900,
  boxShadow: "0 16px 40px rgba(0,0,0,0.12)",
  animation: "floatGlow 4s ease-in-out infinite",
};

const brandTitleStyle: CSSProperties = {
  fontSize: 38,
  fontWeight: 900,
  lineHeight: 1.05,
};

const brandSubStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 18,
  color: "rgba(236,254,255,0.82)",
  fontWeight: 500,
};

const heroBadgeStyle: CSSProperties = {
  marginTop: 28,
  width: "fit-content",
  borderRadius: 999,
  padding: "9px 16px",
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 0.4,
};

const heroTitleStyle: CSSProperties = {
  margin: "22px 0 0 0",
  fontSize: 56,
  lineHeight: 1.02,
  fontWeight: 900,
  maxWidth: 700,
};

const heroTextStyle: CSSProperties = {
  margin: "18px 0 0 0",
  fontSize: 18,
  lineHeight: 1.75,
  color: "rgba(236,254,255,0.9)",
  maxWidth: 700,
};

const featureGridStyle: CSSProperties = {
  marginTop: 28,
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 16,
  maxWidth: 760,
};

const featureCardStyle: CSSProperties = {
  borderRadius: 24,
  padding: 18,
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 16px 40px rgba(0,0,0,0.08)",
};

const featureDotStyle: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "#ccfbf1",
};

const featureTitleStyle: CSSProperties = {
  marginTop: 14,
  fontSize: 18,
  fontWeight: 800,
  color: "#ffffff",
};

const featureTextStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  lineHeight: 1.6,
  color: "rgba(236,254,255,0.82)",
};

const rightWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 500,
  borderRadius: 34,
  padding: 30,
  background: "rgba(8, 25, 43, 0.78)",
  border: "1px solid rgba(255,255,255,0.12)",
  boxShadow: "0 30px 100px rgba(2,8,23,0.28)",
  backdropFilter: "blur(16px)",
};

const cardTopStyle: CSSProperties = {
  textAlign: "center",
};

const loginIconWrapStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
};

const loginIconStyle: CSSProperties = {
  width: 74,
  height: 74,
  borderRadius: 24,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.12)",
  color: "#ffffff",
  fontSize: 32,
  fontWeight: 900,
  boxShadow: "0 16px 40px rgba(0,0,0,0.14)",
};

const cardTitleStyle: CSSProperties = {
  margin: "20px 0 0 0",
  fontSize: 34,
  lineHeight: 1.1,
  fontWeight: 900,
  color: "#ffffff",
};

const cardTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  fontSize: 15,
  lineHeight: 1.6,
  color: "rgba(226,232,240,0.82)",
};

const formStyle: CSSProperties = {
  marginTop: 28,
  display: "grid",
  gap: 18,
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  fontSize: 13,
  fontWeight: 800,
  color: "#dbeafe",
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 18,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  padding: "15px 16px",
  fontSize: 15,
  outline: "none",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
};

const errorBoxStyle: CSSProperties = {
  borderRadius: 18,
  padding: "14px 16px",
  background: "rgba(220, 38, 38, 0.18)",
  border: "1px solid rgba(248, 113, 113, 0.35)",
  color: "#fecaca",
  fontSize: 14,
  lineHeight: 1.5,
};

const buttonStyle: CSSProperties = {
  marginTop: 4,
  width: "100%",
  border: "none",
  borderRadius: 18,
  padding: "16px 18px",
  background: "linear-gradient(135deg, #ccfbf1 0%, #ecfeff 100%)",
  color: "#0f766e",
  fontSize: 16,
  fontWeight: 900,
  boxShadow: "0 18px 40px rgba(204,251,241,0.20)",
};

const buttonLoadingWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
};

const spinnerStyle: CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  border: "2px solid rgba(15,118,110,0.25)",
  borderTop: "2px solid #0f766e",
  animation: "spin 1s linear infinite",
};