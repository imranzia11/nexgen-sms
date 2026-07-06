"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";

type ToastType = "success" | "error" | "info";

type SlotState = {
  slot: number;
  name: string;
  smsMessage: string;
  followUpMessage: string;
  saving: boolean;
};

const TOTAL_SLOTS = 6;
const COMPLIANCE_FOOTER = "Reply STOP to opt out, HELP for help.";

function containsComplianceLine(text: string): boolean {
  return text.toLowerCase().includes("reply stop to opt out");
}

function makeEmptySlots(): SlotState[] {
  return Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    name: `Template ${i + 1}`,
    smsMessage: COMPLIANCE_FOOTER,
    followUpMessage: COMPLIANCE_FOOTER,
    saving: false,
  }));
}

export default function TemplatesPage() {
  const router = useRouter();
  const toastTimerRef = useRef<number | null>(null);

  const [checking, setChecking] = useState(true);
  const [userName, setUserName] = useState("User");
  const [profileUid, setProfileUid] = useState("");

  const [slots, setSlots] = useState<SlotState[]>(makeEmptySlots());
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [toastOpen, setToastOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState<ToastType>("info");

  const showToast = (msg: string, type: ToastType = "info") => {
    setToastMessage(msg);
    setToastType(type);
    setToastOpen(true);

    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToastOpen(false);
    }, 4000);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      try {
        const snap = await getDoc(doc(db, "users", user.uid));

        if (!snap.exists() || snap.data().isActive !== true) {
          await signOut(auth).catch(() => {});
          router.push("/login");
          return;
        }

        const safeName =
          String(snap.data().name || "").trim() ||
          String(user.displayName || "").trim() ||
          String(user.email || "").split("@")[0] ||
          "User";

        setUserName(safeName);
        setProfileUid(user.uid);
        setChecking(false);
        await loadSlots(user.uid);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  const loadSlots = async (uid?: string) => {
    try {
      setLoadingSlots(true);

      const currentUid = uid || profileUid || auth.currentUser?.uid;
      if (!currentUid) return;

      const q = query(
        collection(db, "messageTemplates"),
        where("ownerUid", "==", currentUid)
      );

      const snap = await getDocs(q);
      const saved = new Map<number, any>();

      snap.docs.forEach((d) => {
        const data = d.data();
        const slotNum = Number(data.slot || 0);
        if (slotNum >= 1 && slotNum <= TOTAL_SLOTS) {
          saved.set(slotNum, data);
        }
      });

      setSlots(
        makeEmptySlots().map((slot) => {
          const data = saved.get(slot.slot);
          if (!data) return slot;

          return {
            ...slot,
            name: String(data.name || slot.name),
            smsMessage: String(data.smsMessage || COMPLIANCE_FOOTER),
            followUpMessage: String(data.followUpMessage || COMPLIANCE_FOOTER),
          };
        })
      );
    } catch (error) {
      console.error("Failed to load templates", error);
      showToast("Failed to load your saved templates.", "error");
    } finally {
      setLoadingSlots(false);
    }
  };

  const updateSlot = (slotNum: number, patch: Partial<SlotState>) => {
    setSlots((prev) =>
      prev.map((s) => (s.slot === slotNum ? { ...s, ...patch } : s))
    );
  };

  const handleSaveSlot = async (slotNum: number) => {
    const user = auth.currentUser;
    if (!user) {
      showToast("You are not signed in.", "error");
      return;
    }

    const slot = slots.find((s) => s.slot === slotNum);
    if (!slot) return;

    const slotLabel = slot.name || `Template ${slotNum}`;

    if (!slot.smsMessage.trim()) {
      showToast(
        `Add an SMS message to "${slotLabel}" before saving.`,
        "error"
      );
      return;
    }

    if (!containsComplianceLine(slot.smsMessage)) {
      showToast(
        `Don't remove "${COMPLIANCE_FOOTER}" from the SMS message in "${slotLabel}".`,
        "error"
      );
      return;
    }

    if (
      slot.followUpMessage.trim() &&
      !containsComplianceLine(slot.followUpMessage)
    ) {
      showToast(
        `Don't remove "${COMPLIANCE_FOOTER}" from the follow-up message in "${slotLabel}".`,
        "error"
      );
      return;
    }

    updateSlot(slotNum, { saving: true });

    try {
      const docId = `${user.uid}_slot${slotNum}`;
      await setDoc(
        doc(db, "messageTemplates", docId),
        {
          ownerUid: user.uid,
          slot: slotNum,
          name: slot.name.trim() || `Template ${slotNum}`,
          smsMessage: slot.smsMessage.trim(),
          followUpMessage: slot.followUpMessage.trim(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      showToast(`"${slotLabel}" saved.`, "success");
    } catch (error: any) {
      console.error(error);
      showToast(error?.message || "Failed to save template.", "error");
    } finally {
      updateSlot(slotNum, { saving: false });
    }
  };

  const handleClearSlot = (slotNum: number) => {
    const ok = window.confirm(
      "Clear this template? Its saved text will be replaced with blank fields (except the required opt-out line) until you save again."
    );
    if (!ok) return;

    updateSlot(slotNum, {
      name: `Template ${slotNum}`,
      smsMessage: COMPLIANCE_FOOTER,
      followUpMessage: COMPLIANCE_FOOTER,
    });
  };

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  if (checking) {
    return (
      <main style={loadingPageStyle}>
        <div style={loadingCardStyle}>
          <div style={spinnerStyle} />
          <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#e6fffb" }}>
            Checking account access...
          </p>
        </div>
        <style jsx global>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </main>
    );
  }

  return (
    <>
      <style jsx global>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes toastIn {
          0% { opacity: 0; transform: translateY(-18px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        input::placeholder, textarea::placeholder {
          color: #94a3b8;
        }
      `}</style>

      {toastOpen ? (
        <div
          style={{
            ...toastStyle,
            ...(toastType === "success"
              ? toastSuccessStyle
              : toastType === "error"
              ? toastErrorStyle
              : toastInfoStyle),
          }}
        >
          <div
            style={{
              ...toastDotStyle,
              background:
                toastType === "success"
                  ? "#34d399"
                  : toastType === "error"
                  ? "#f87171"
                  : "#22d3ee",
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={toastTitleStyle}>
              {toastType === "success"
                ? "Saved"
                : toastType === "error"
                ? "Something went wrong"
                : "Update"}
            </div>
            <div style={toastMessageStyle}>{toastMessage}</div>
          </div>
          <button onClick={() => setToastOpen(false)} style={toastCloseStyle}>
            ×
          </button>
        </div>
      ) : null}

      <main style={pageStyle}>
        <div style={pageShellStyle}>
          <aside style={sidebarStyle}>
            <div>
              <div style={brandWrapStyle}>
                <div style={brandIconStyle}>N</div>
                <div>
                  <div style={brandTitleStyle}>Nexgen SMS</div>
                  <div style={brandSubStyle}>Admin Portal</div>
                </div>
              </div>

              <div style={adminMiniCardStyle}>
                <div style={avatarStyle}>
                  {userName?.slice(0, 1)?.toUpperCase() || "U"}
                </div>
                <div>
                  <div style={sidebarSmallLabelStyle}>Signed in as</div>
                  <div style={sidebarAdminNameStyle}>{userName}</div>
                </div>
              </div>

              <div style={sidebarLinkWrapStyle}>
                <Link href="/dashboard" style={sidebarCardStyle}>
                  <div style={sidebarIconStyle}>←</div>
                  <div>
                    <div style={sidebarCardTitleStyle}>Back to dashboard</div>
                    <div style={sidebarCardTextStyle}>
                      Return to the SMS portal
                    </div>
                  </div>
                </Link>
              </div>
            </div>

            <button onClick={handleLogout} style={sidebarLogoutButtonStyle}>
              Logout
            </button>
          </aside>

          <section style={contentStyle}>
            <div style={heroCardStyle}>
              <div style={heroInnerStyle}>
                <div style={heroBadgeStyle}>Message templates</div>
                <h1 style={heroTitleStyle}>Set up your templates</h1>
                <p style={heroTextStyle}>
                  Fill in up to {TOTAL_SLOTS} reusable templates, each with its
                  own SMS message and follow-up message. Save a template here
                  and it shows up in the "Load a saved template" dropdown on
                  the dashboard.
                </p>
              </div>
            </div>

            <div style={complianceBannerStyle}>
              <strong>⚠️ Do not delete "{COMPLIANCE_FOOTER}"</strong> from any
              SMS or follow-up message. It's pre-filled in every template and
              is required for SMS compliance — saving is blocked if it's
              removed.
            </div>

            <div style={slotsGridStyle}>
              {slots.map((slot) => (
                <section key={slot.slot} style={slotCardStyle}>
                  <div style={slotHeaderStyle}>
                    <div style={slotNumberStyle}>{slot.slot}</div>
                    <input
                      value={slot.name}
                      onChange={(e) =>
                        updateSlot(slot.slot, { name: e.target.value })
                      }
                      placeholder={`Template ${slot.slot}`}
                      style={slotNameInputStyle}
                    />
                  </div>

                  <label style={fieldLabelStyle}>SMS message</label>
                  <textarea
                    value={slot.smsMessage}
                    onChange={(e) =>
                      updateSlot(slot.slot, { smsMessage: e.target.value })
                    }
                    rows={4}
                    placeholder="Reply STOP to opt out, Reply YES to get funds."
                    style={fieldTextareaStyle}
                  />
                  <div style={charHintStyle}>
                    <span>Characters:</span>
                    <strong>{slot.smsMessage.length}</strong>
                  </div>
                  {!containsComplianceLine(slot.smsMessage) ? (
                    <div style={complianceWarningStyle}>
                      Missing required opt-out line — saving is disabled
                      until it's added back.
                    </div>
                  ) : null}

                  <label style={{ ...fieldLabelStyle, marginTop: 14 }}>
                    Follow-up message
                  </label>
                  <textarea
                    value={slot.followUpMessage}
                    onChange={(e) =>
                      updateSlot(slot.slot, {
                        followUpMessage: e.target.value,
                      })
                    }
                    rows={3}
                    placeholder="Hey, following up to know if you're still interested."
                    style={fieldTextareaStyle}
                  />
                  {slot.followUpMessage.trim() &&
                  !containsComplianceLine(slot.followUpMessage) ? (
                    <div style={complianceWarningStyle}>
                      Missing required opt-out line — saving is disabled
                      until it's added back.
                    </div>
                  ) : null}

                  <div style={slotActionsStyle}>
                    <button
                      onClick={() => handleSaveSlot(slot.slot)}
                      disabled={slot.saving || loadingSlots}
                      style={{
                        ...saveButtonStyle,
                        opacity: slot.saving ? 0.7 : 1,
                        cursor: slot.saving ? "not-allowed" : "pointer",
                      }}
                    >
                      {slot.saving ? "Saving..." : "Save template"}
                    </button>
                    <button
                      onClick={() => handleClearSlot(slot.slot)}
                      style={clearButtonStyle}
                      type="button"
                    >
                      Clear
                    </button>
                  </div>
                </section>
              ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(20,184,166,0.18), transparent 28%), linear-gradient(180deg, #ecfeff 0%, #f8fafc 46%, #f8fafc 100%)",
  color: "#0f172a",
};

const pageShellStyle: CSSProperties = {
  width: "100%",
  minHeight: "100vh",
  display: "grid",
  gridTemplateColumns: "290px 1fr",
};

const sidebarStyle: CSSProperties = {
  background: "linear-gradient(180deg, #0f766e 0%, #0b5f59 100%)",
  padding: 24,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  gap: 24,
  position: "sticky",
  top: 0,
  minHeight: "100vh",
};

const brandWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const brandIconStyle: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 18,
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.14)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 22,
};

const brandTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 20,
  lineHeight: 1.1,
};

const brandSubStyle: CSSProperties = {
  marginTop: 4,
  color: "rgba(236, 254, 255, 0.7)",
  fontSize: 13,
};

const adminMiniCardStyle: CSSProperties = {
  marginTop: 24,
  borderRadius: 22,
  padding: 16,
  background: "rgba(255,255,255,0.09)",
  border: "1px solid rgba(255,255,255,0.12)",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const avatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontWeight: 800,
  fontSize: 18,
  flexShrink: 0,
};

const sidebarSmallLabelStyle: CSSProperties = {
  color: "rgba(236, 254, 255, 0.68)",
  fontSize: 12,
};

const sidebarAdminNameStyle: CSSProperties = {
  marginTop: 4,
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 800,
};

const sidebarLinkWrapStyle: CSSProperties = {
  marginTop: 18,
};

const sidebarCardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  textDecoration: "none",
};

const sidebarIconStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 20,
  fontWeight: 900,
  flexShrink: 0,
};

const sidebarCardTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 16,
  fontWeight: 900,
  lineHeight: 1.1,
};

const sidebarCardTextStyle: CSSProperties = {
  marginTop: 6,
  color: "rgba(236, 254, 255, 0.78)",
  fontSize: 12,
  lineHeight: 1.4,
};

const sidebarLogoutButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 16,
  padding: "14px 16px",
  background: "transparent",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
};

const contentStyle: CSSProperties = {
  padding: 24,
  display: "grid",
  gap: 20,
};

const heroCardStyle: CSSProperties = {
  borderRadius: 32,
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 30px 80px rgba(13, 148, 136, 0.28)",
};

const heroInnerStyle: CSSProperties = {
  padding: 28,
};

const heroBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  width: "fit-content",
  borderRadius: 999,
  padding: "8px 14px",
  background: "rgba(255,255,255,0.14)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ecfeff",
  fontSize: 12,
  fontWeight: 800,
};

const heroTitleStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "#ffffff",
  fontSize: 34,
  lineHeight: 1.1,
  fontWeight: 900,
};

const heroTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  maxWidth: 760,
  color: "rgba(236,254,255,0.86)",
  fontSize: 15,
  lineHeight: 1.6,
};

const complianceBannerStyle: CSSProperties = {
  borderRadius: 18,
  padding: "14px 18px",
  background: "#fffbeb",
  border: "1px solid #fbbf24",
  color: "#92400e",
  fontSize: 14,
  lineHeight: 1.5,
};

const complianceWarningStyle: CSSProperties = {
  marginTop: 6,
  color: "#b91c1c",
  fontSize: 12,
  fontWeight: 700,
};

const slotsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 18,
};

const slotCardStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 24,
  padding: 20,
  boxShadow: "0 12px 30px rgba(15,23,42,0.05)",
};

const slotHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 16,
};

const slotNumberStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontWeight: 900,
  fontSize: 14,
  flexShrink: 0,
};

const slotNameInputStyle: CSSProperties = {
  flex: 1,
  borderRadius: 14,
  border: "1px solid #dbe3ed",
  padding: "10px 14px",
  background: "#f8fafc",
  color: "#0f172a",
  fontSize: 15,
  fontWeight: 700,
  outline: "none",
};

const fieldLabelStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  color: "#334155",
  fontSize: 13,
  fontWeight: 800,
};

const fieldTextareaStyle: CSSProperties = {
  width: "100%",
  borderRadius: 16,
  border: "1px solid #dbe3ed",
  padding: "12px 14px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 14,
  resize: "vertical",
  outline: "none",
};

const charHintStyle: CSSProperties = {
  marginTop: 8,
  display: "flex",
  justifyContent: "flex-end",
  gap: 6,
  color: "#94a3b8",
  fontSize: 12,
};

const slotActionsStyle: CSSProperties = {
  marginTop: 16,
  display: "flex",
  gap: 10,
};

const saveButtonStyle: CSSProperties = {
  flex: 1,
  border: "none",
  borderRadius: 14,
  padding: "12px 16px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 14,
};

const clearButtonStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#ffffff",
  color: "#475569",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
};

const loadingPageStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 50%, #14b8a6 100%)",
};

const loadingCardStyle: CSSProperties = {
  borderRadius: 28,
  padding: "28px 32px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.25)",
  borderTop: "3px solid #ffffff",
  animation: "spin 1s linear infinite",
};

const toastStyle: CSSProperties = {
  position: "fixed",
  top: 24,
  right: 24,
  zIndex: 9999,
  width: "min(560px, calc(100vw - 32px))",
  borderRadius: 26,
  padding: "18px 18px",
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
  boxShadow: "0 30px 80px rgba(2, 8, 23, 0.32)",
  animation: "toastIn 0.28s ease-out",
  border: "1px solid rgba(255,255,255,0.08)",
};

const toastSuccessStyle: CSSProperties = {
  background: "linear-gradient(135deg, #052e2b 0%, #065f46 100%)",
  color: "#ffffff",
};

const toastErrorStyle: CSSProperties = {
  background: "linear-gradient(135deg, #3f0d0d 0%, #991b1b 100%)",
  color: "#ffffff",
};

const toastInfoStyle: CSSProperties = {
  background: "linear-gradient(135deg, #0f172a 0%, #0b2545 100%)",
  color: "#ffffff",
};

const toastDotStyle: CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  flexShrink: 0,
  marginTop: 4,
};

const toastTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  lineHeight: 1.2,
};

const toastMessageStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 15,
  lineHeight: 1.6,
  color: "rgba(255,255,255,0.95)",
};

const toastCloseStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#ffffff",
  fontSize: 24,
  lineHeight: 1,
  cursor: "pointer",
  opacity: 0.85,
};
