"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import Papa from "papaparse";
import { auth, db } from "../../lib/firebase";
import LoadingScreen from "../../components/LoadingScreen";

type RowData = Record<string, string>;

type EmailLeadItem = {
  name: string;
  email: string;
  valid: boolean;
};

// Same chunk size convention as SEND_CHUNK_SIZE in app/dashboard/page.tsx
// and MAX_RECIPIENTS_PER_REQUEST in app/api/send-email-blast/route.ts.
const SEND_CHUNK_SIZE = 150;

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function guessEmailColumn(headers: string[]) {
  const priorities = [
    "email",
    "e-mail",
    "email_address",
    "emailaddress",
    "work_email",
    "contact_email",
  ];

  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  for (const target of priorities) {
    const foundIndex = normalized.findIndex((h) => h === target || h.includes(target));
    if (foundIndex !== -1) return headers[foundIndex];
  }

  return headers[0] || "";
}

function guessNameFromRow(row: RowData) {
  return (
    row["Name"] ||
    row["name"] ||
    row["Full Name"] ||
    row["full_name"] ||
    row["Customer Name"] ||
    row["customer_name"] ||
    row["First Name"] ||
    row["first_name"] ||
    ""
  );
}

export default function EmailMarketingPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [userName, setUserName] = useState("User");

  // Gate: user re-confirms the sending email address for this account
  // before the compose/upload UI unlocks. See
  // app/api/email-marketing/verify-sender/route.ts for what this actually
  // checks - it's a confirmation step, not a second password.
  const [unlocked, setUnlocked] = useState(false);
  const [gateEmail, setGateEmail] = useState("");
  const [gateError, setGateError] = useState("");
  const [gateLoading, setGateLoading] = useState(false);
  const [senderEmail, setSenderEmail] = useState("");
  const [senderName, setSenderName] = useState("");

  // Uploaded leads (Name + Email columns).
  const [leads, setLeads] = useState<EmailLeadItem[]>([]);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [csvError, setCsvError] = useState("");

  // Compose fields.
  const [campaignName, setCampaignName] = useState("");
  const [subject, setSubject] = useState("");
  const [messageBody, setMessageBody] = useState("");

  // Send state.
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState<{
    chunkIndex: number;
    totalChunks: number;
    sentSoFar: number;
    totalLeads: number;
  } | null>(null);
  const [sendSummary, setSendSummary] = useState<{
    sent: number;
    failed: number;
    skippedDuplicates: number;
    skippedInvalid: number;
  } | null>(null);
  const [sendError, setSendError] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

        const userData = snap.data() as Record<string, any>;
        const safeName =
          String(userData.name || "").trim() ||
          String(user.displayName || "").trim() ||
          String(user.email || "").split("@")[0] ||
          "User";

        setUserName(safeName);
        setChecking(false);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
    });

    return () => unsub();
  }, [router]);

  // Warn before closing/refreshing mid-blast, same as the dashboard's
  // chunked SMS send - closing the tab would abandon any chunks not yet
  // sent.
  useEffect(() => {
    if (!sendProgress || sendProgress.totalChunks <= 1) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [sendProgress]);

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  const handleGateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateError("");

    const trimmed = gateEmail.trim();
    if (!trimmed) {
      setGateError("Enter your sending email address.");
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      router.push("/login");
      return;
    }

    setGateLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/email-marketing/verify-sender", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setGateError(data.error || "Could not verify that email.");
        setGateLoading(false);
        return;
      }

      setSenderEmail(data.senderEmail || trimmed);
      setSenderName(data.senderName || "");
      setUnlocked(true);
    } catch (err) {
      console.error("verify-sender request failed", err);
      setGateError("Something went wrong verifying that email. Try again.");
    } finally {
      setGateLoading(false);
    }
  };

  const handleCsvUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setCsvError("");
    setUploadedFileName(file.name);
    setSendSummary(null);
    setSendError("");

    Papa.parse<RowData>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = (results.data || []).filter(
          (row) => row && Object.values(row).some((v) => String(v || "").trim())
        );

        if (rows.length === 0) {
          setCsvError("That file doesn't have any rows we could read.");
          setLeads([]);
          return;
        }

        const detectedHeaders = results.meta.fields || Object.keys(rows[0]);
        const emailColumn = guessEmailColumn(detectedHeaders);

        const parsedLeads: EmailLeadItem[] = rows.map((row) => {
          const rawEmail = String(row[emailColumn] || "").trim();
          const name = String(guessNameFromRow(row) || "").trim();
          return {
            name,
            email: rawEmail,
            valid: isValidEmail(rawEmail),
          };
        });

        setLeads(parsedLeads);
      },
      error: (err) => {
        console.error("CSV parse failed", err);
        setCsvError("Couldn't read that file. Make sure it's a .csv with a header row.");
        setLeads([]);
      },
    });

    // Allow re-uploading the same file name after clearing.
    event.target.value = "";
  };

  const clearUpload = () => {
    setLeads([]);
    setUploadedFileName("");
    setCsvError("");
  };

  const validLeads = leads.filter((l) => l.valid);
  const invalidCount = leads.length - validLeads.length;

  const handleSendBlast = async () => {
    setSendError("");
    setSendSummary(null);

    if (!subject.trim()) {
      setSendError("Add a subject line before sending.");
      return;
    }
    if (!messageBody.trim()) {
      setSendError("Add a message before sending.");
      return;
    }
    if (validLeads.length === 0) {
      setSendError("Upload a lead list with at least one valid email first.");
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      router.push("/login");
      return;
    }

    const html = messageBody
      .trim()
      .split(/\n{2,}/)
      .map((para) => `<p>${para.replace(/\n/g, "<br />")}</p>`)
      .join("");

    const chunks: EmailLeadItem[][] = [];
    for (let i = 0; i < validLeads.length; i += SEND_CHUNK_SIZE) {
      chunks.push(validLeads.slice(i, i + SEND_CHUNK_SIZE));
    }

    setSending(true);
    let totalSent = 0;
    let totalFailed = 0;
    let totalSkippedDuplicates = 0;
    let totalSkippedInvalid = 0;

    setSendProgress({
      chunkIndex: 0,
      totalChunks: chunks.length,
      sentSoFar: 0,
      totalLeads: validLeads.length,
    });

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Fresh ID token per chunk - a large blast can outlive the ~1hr token
      // lifetime, same reasoning as the SMS chunked-send loop in
      // app/dashboard/page.tsx.
      const chunkToken = await user.getIdToken();

      try {
        const res = await fetch("/api/send-email-blast", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${chunkToken}`,
          },
          body: JSON.stringify({
            campaignName: campaignName.trim(),
            subject: subject.trim(),
            html,
            text: messageBody.trim(),
            recipients: chunk.map((l) => ({ name: l.name, email: l.email })),
          }),
        });
        const data = await res.json();

        if (res.ok && data.ok) {
          totalSent += data.sentCount || 0;
          totalFailed += data.failedCount || 0;
          totalSkippedDuplicates += data.skippedDuplicates || 0;
          totalSkippedInvalid += data.skippedInvalid || 0;
        } else {
          totalFailed += chunk.length;
          setSendError(data.error || "A batch failed to send.");
        }
      } catch (err) {
        console.error("send-email-blast chunk failed", err);
        totalFailed += chunk.length;
      }

      setSendProgress({
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        sentSoFar: totalSent + totalFailed,
        totalLeads: validLeads.length,
      });
    }

    setSending(false);
    setSendProgress(null);
    setSendSummary({
      sent: totalSent,
      failed: totalFailed,
      skippedDuplicates: totalSkippedDuplicates,
      skippedInvalid: totalSkippedInvalid,
    });
  };

  if (checking) {
    return <LoadingScreen text="Loading email marketing..." />;
  }

  return (
    <main style={pageStyle}>
      <div style={pageShellStyle}>
        <aside style={sidebarStyle}>
          <div>
            <div style={brandWrapStyle}>
              <div style={brandIconStyle}>N</div>
              <div>
                <div style={brandTitleStyle}>Nexgen</div>
                <div style={brandSubStyle}>Email Campaigns</div>
              </div>
            </div>

            <div style={adminMiniCardStyle}>
              <div style={avatarStyle}>{userName?.slice(0, 1)?.toUpperCase() || "U"}</div>
              <div>
                <div style={sidebarSmallLabelStyle}>Signed in as</div>
                <div style={sidebarAdminNameStyle}>{userName}</div>
              </div>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/dashboard" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>⌂</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Dashboard</div>
                  <div style={sidebarRepliesTextStyle}>Back to SMS control center</div>
                </div>
              </Link>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <Link href="/help" style={sidebarRepliesCardStyle}>
                <div style={sidebarRepliesIconStyle}>🎧</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Help Center</div>
                  <div style={sidebarRepliesTextStyle}>Ask a question, get instant help</div>
                </div>
              </Link>
            </div>

            <div style={sidebarRepliesWrapStyle}>
              <div style={{ ...sidebarRepliesCardStyle, background: "rgba(255,255,255,0.18)" }}>
                <div style={sidebarRepliesIconStyle}>📧</div>
                <div>
                  <div style={sidebarRepliesTitleStyle}>Email Marketing</div>
                  <div style={sidebarRepliesTextStyle}>You&apos;re here</div>
                </div>
              </div>
            </div>
          </div>

          <div style={sidebarBottomLogoutWrapStyle}>
            <div style={{ display: "grid", gap: 12 }}>
              <Link href="/logs" style={sidebarSecondaryLinkButtonStyle}>
                Logs
              </Link>

              <Link href="/stats" style={sidebarSecondaryLinkButtonStyle}>
                Stats
              </Link>

              <a
                href="https://nexgenmerchant-finder.web.app/"
                target="_blank"
                rel="noopener noreferrer"
                style={sidebarSecondaryLinkButtonStyle}
              >
                Beta Version - Lead Generation
              </a>

              <button onClick={handleLogout} style={sidebarLogoutButtonStyle}>
                Logout
              </button>
            </div>
          </div>
        </aside>

        <section style={contentStyle}>
          <div style={headerStyle}>
            <div style={headerAvatarStyle}>📧</div>
            <div>
              <div style={headerTitleStyle}>Email Marketing</div>
              <div style={headerSubStyle}>
                {unlocked
                  ? `Sending as ${senderName ? `${senderName} · ` : ""}${senderEmail}`
                  : "Confirm your sending email to continue"}
              </div>
            </div>
          </div>

          {!unlocked ? (
            <div style={panelStyle}>
              <div style={gateCardStyle}>
                <div style={gateIconStyle}>✉️</div>
                <h2 style={gateTitleStyle}>Confirm your sending email</h2>
                <p style={gateTextStyle}>
                  Enter the official company email address assigned to your account.
                  We&apos;ll check it against what&apos;s on file before opening the
                  campaign tools.
                </p>

                <form onSubmit={handleGateSubmit} style={gateFormStyle}>
                  <input
                    type="email"
                    value={gateEmail}
                    onChange={(e) => setGateEmail(e.target.value)}
                    placeholder="you@nexgenmerchant.io"
                    style={gateInputStyle}
                    autoComplete="email"
                  />
                  <button type="submit" style={gateButtonStyle} disabled={gateLoading}>
                    {gateLoading ? "Checking..." : "Continue"}
                  </button>
                </form>

                {gateError ? <div style={gateErrorStyle}>{gateError}</div> : null}
              </div>
            </div>
          ) : (
            <div style={panelStyle}>
              <div style={metricsRowStyle}>
                <div style={metricCardStyle}>
                  <div style={metricLabelStyle}>Valid leads</div>
                  <div style={metricValueStyle}>{validLeads.length}</div>
                </div>
                <div style={metricCardStyle}>
                  <div style={metricLabelStyle}>Skipped rows</div>
                  <div style={metricValueStyle}>{invalidCount}</div>
                </div>
                <div style={metricCardStyle}>
                  <div style={metricLabelStyle}>Sent this session</div>
                  <div style={{ ...metricValueStyle, color: "var(--text-success, #166534)" }}>
                    {sendSummary?.sent ?? 0}
                  </div>
                </div>
                <div style={metricCardStyle}>
                  <div style={metricLabelStyle}>Failed this session</div>
                  <div style={{ ...metricValueStyle, color: sendSummary?.failed ? "#b91c1c" : undefined }}>
                    {sendSummary?.failed ?? 0}
                  </div>
                </div>
              </div>

              <div style={cardStyle}>
                <h3 style={cardTitleStyle}>1. Upload leads</h3>
                <p style={cardHintStyle}>
                  Upload a .csv with a header row containing at least an Email
                  column (Name is optional but recommended).
                </p>

                <div style={uploadRowStyle}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    onChange={handleCsvUpload}
                    style={{ display: "none" }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={uploadButtonStyle}
                  >
                    Choose CSV file
                  </button>
                  {uploadedFileName ? (
                    <>
                      <span style={uploadedFileNameStyle}>{uploadedFileName}</span>
                      <button type="button" onClick={clearUpload} style={clearButtonStyle}>
                        Clear
                      </button>
                    </>
                  ) : null}
                </div>

                {csvError ? <div style={gateErrorStyle}>{csvError}</div> : null}

                {leads.length > 0 ? (
                  <>
                    <div style={leadStatsRowStyle}>
                      <div style={leadStatChipStyle}>
                        {leads.length} rows read
                      </div>
                      <div style={{ ...leadStatChipStyle, ...leadStatGoodStyle }}>
                        {validLeads.length} valid emails
                      </div>
                      {invalidCount > 0 ? (
                        <div style={{ ...leadStatChipStyle, ...leadStatBadStyle }}>
                          {invalidCount} skipped (invalid)
                        </div>
                      ) : null}
                    </div>

                    <div style={leadTableWrapStyle}>
                      <table style={leadTableStyle}>
                        <thead>
                          <tr>
                            <th style={leadTableHeadCellStyle}>Name</th>
                            <th style={leadTableHeadCellStyle}>Email</th>
                            <th style={leadTableHeadCellStyle}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leads.slice(0, 200).map((lead, idx) => (
                            <tr key={`${lead.email}-${idx}`}>
                              <td style={leadTableCellStyle}>{lead.name || "-"}</td>
                              <td style={leadTableCellStyle}>{lead.email || "-"}</td>
                              <td style={leadTableCellStyle}>
                                {lead.valid ? (
                                  <span style={validBadgeStyle}>Valid</span>
                                ) : (
                                  <span style={invalidBadgeStyle}>Invalid</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {leads.length > 200 ? (
                        <div style={cardHintStyle}>
                          Showing first 200 of {leads.length} rows - all valid rows will still
                          be sent.
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>

              <div style={cardStyle}>
                <h3 style={cardTitleStyle}>2. Compose</h3>

                <label style={fieldLabelStyle}>Campaign name (optional)</label>
                <input
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g. August funding follow-up"
                  style={fieldInputStyle}
                />

                <label style={fieldLabelStyle}>Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject line"
                  style={fieldInputStyle}
                />

                <label style={fieldLabelStyle}>Message</label>
                <textarea
                  value={messageBody}
                  onChange={(e) => setMessageBody(e.target.value)}
                  placeholder="Write your email..."
                  style={fieldTextareaStyle}
                  rows={10}
                />

                <div style={noteBoxStyle}>
                  Every email opens with &quot;Hello [Name],&quot; using the Name column
                  from your uploaded CSV - you don&apos;t need to type a greeting yourself.
                  If a lead replies, it lands in your own email inbox (the address you log
                  into for nexgenmerchant.io) - not in this app - so check that inbox
                  directly to see and respond to replies.
                </div>

                {sendError ? <div style={gateErrorStyle}>{sendError}</div> : null}

                {sendSummary ? (
                  <div style={summaryCardStyle}>
                    Sent {sendSummary.sent} · Failed {sendSummary.failed}
                    {sendSummary.skippedDuplicates
                      ? ` · Skipped ${sendSummary.skippedDuplicates} duplicates`
                      : ""}
                    {sendSummary.skippedInvalid
                      ? ` · Skipped ${sendSummary.skippedInvalid} invalid`
                      : ""}
                  </div>
                ) : null}

                {sendProgress && sendProgress.totalChunks > 1 ? (
                  <div style={sendProgressCardStyle}>
                    <div style={sendProgressTopRowStyle}>
                      <span style={sendProgressTitleStyle}>
                        Sending batch {sendProgress.chunkIndex} of {sendProgress.totalChunks}
                      </span>
                      <span style={sendProgressCountStyle}>
                        {sendProgress.sentSoFar} / {sendProgress.totalLeads}
                      </span>
                    </div>
                    <div style={sendProgressTrackStyle}>
                      <div
                        style={{
                          ...sendProgressFillStyle,
                          width: `${
                            (sendProgress.sentSoFar / Math.max(sendProgress.totalLeads, 1)) * 100
                          }%`,
                        }}
                      />
                    </div>
                    <div style={sendProgressWarningStyle}>
                      Please don&apos;t close or refresh this tab until the send finishes.
                    </div>
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={handleSendBlast}
                  style={sendButtonStyle}
                  disabled={sending || validLeads.length === 0}
                >
                  {sending
                    ? "Sending..."
                    : `Send to ${validLeads.length} lead${validLeads.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
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
  boxShadow: "inset -1px 0 0 rgba(255,255,255,0.08)",
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
  boxShadow: "0 10px 25px rgba(0,0,0,0.18)",
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

const sidebarRepliesWrapStyle: CSSProperties = {
  marginTop: 18,
};

const sidebarRepliesCardStyle: CSSProperties = {
  width: "100%",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  textDecoration: "none",
};

const sidebarRepliesIconStyle: CSSProperties = {
  width: 54,
  height: 54,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 24,
  fontWeight: 900,
  flexShrink: 0,
};

const sidebarRepliesTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 18,
  fontWeight: 900,
  lineHeight: 1.1,
};

const sidebarRepliesTextStyle: CSSProperties = {
  marginTop: 6,
  color: "rgba(236, 254, 255, 0.78)",
  fontSize: 13,
  lineHeight: 1.4,
};

const sidebarBottomLogoutWrapStyle: CSSProperties = {
  display: "grid",
};

const sidebarSecondaryLinkButtonStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 16,
  padding: "14px 16px",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
  textDecoration: "none",
  textAlign: "center",
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
  gap: 16,
  gridTemplateRows: "auto 1fr",
  minHeight: "100vh",
  overflowY: "auto",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  borderRadius: 24,
  padding: "18px 22px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 20px 50px rgba(13, 148, 136, 0.22)",
};

const headerAvatarStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.18)",
  fontSize: 22,
  flexShrink: 0,
};

const headerTitleStyle: CSSProperties = {
  color: "#ffffff",
  fontSize: 20,
  fontWeight: 900,
};

const headerSubStyle: CSSProperties = {
  marginTop: 4,
  color: "rgba(236,254,255,0.85)",
  fontSize: 13,
};

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 16,
  alignContent: "start",
};

const metricsRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 12,
};

const metricCardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.94)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 18,
  boxShadow: "0 10px 24px rgba(15,23,42,0.05)",
  padding: "16px 18px",
};

const metricLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const metricValueStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 28,
  fontWeight: 900,
  color: "#0f172a",
};

const noteBoxStyle: CSSProperties = {
  marginTop: 14,
  borderRadius: 12,
  padding: "12px 14px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  fontSize: 12.5,
  lineHeight: 1.6,
};

const gateCardStyle: CSSProperties = {
  maxWidth: 480,
  margin: "40px auto",
  background: "rgba(255,255,255,0.94)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 28,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  padding: "34px 30px",
  textAlign: "center",
};

const gateIconStyle: CSSProperties = {
  width: 64,
  height: 64,
  margin: "0 auto 16px auto",
  borderRadius: "50%",
  background: "#ccfbf1",
  display: "grid",
  placeItems: "center",
  fontSize: 30,
};

const gateTitleStyle: CSSProperties = {
  margin: 0,
  color: "#0f172a",
  fontSize: 22,
  fontWeight: 900,
};

const gateTextStyle: CSSProperties = {
  margin: "10px 0 20px 0",
  color: "#475569",
  fontSize: 14,
  lineHeight: 1.6,
};

const gateFormStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const gateInputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid #cbd5e1",
  borderRadius: 14,
  padding: "14px 16px",
  fontSize: 15,
  boxSizing: "border-box",
};

const gateButtonStyle: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: 14,
  padding: "14px 16px",
  background: "#0d9488",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 15,
  cursor: "pointer",
};

const gateErrorStyle: CSSProperties = {
  marginTop: 6,
  color: "#b91c1c",
  fontSize: 13.5,
  textAlign: "left",
};

const cardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.94)",
  border: "1px solid rgba(15,23,42,0.06)",
  borderRadius: 24,
  boxShadow: "0 16px 40px rgba(15,23,42,0.06)",
  padding: "22px 24px",
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 900,
  color: "#0f172a",
};

const cardHintStyle: CSSProperties = {
  marginTop: 6,
  marginBottom: 14,
  color: "#64748b",
  fontSize: 13.5,
  lineHeight: 1.5,
};

const uploadRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

const uploadButtonStyle: CSSProperties = {
  border: "1px solid #0d9488",
  borderRadius: 12,
  padding: "10px 16px",
  background: "#f0fdfa",
  color: "#0f766e",
  fontWeight: 800,
  fontSize: 13.5,
  cursor: "pointer",
};

const uploadedFileNameStyle: CSSProperties = {
  color: "#334155",
  fontSize: 13.5,
};

const clearButtonStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#b91c1c",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const leadStatsRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  marginTop: 16,
};

const leadStatChipStyle: CSSProperties = {
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12.5,
  fontWeight: 800,
  background: "#f1f5f9",
  color: "#334155",
};

const leadStatGoodStyle: CSSProperties = {
  background: "#dcfce7",
  color: "#166534",
};

const leadStatBadStyle: CSSProperties = {
  background: "#fee2e2",
  color: "#991b1b",
};

const leadTableWrapStyle: CSSProperties = {
  marginTop: 14,
  maxHeight: 320,
  overflowY: "auto",
  border: "1px solid #e2e8f0",
  borderRadius: 14,
};

const leadTableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13.5,
};

const leadTableHeadCellStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  background: "#f8fafc",
  textAlign: "left",
  padding: "10px 14px",
  color: "#475569",
  fontWeight: 800,
  borderBottom: "1px solid #e2e8f0",
};

const leadTableCellStyle: CSSProperties = {
  padding: "9px 14px",
  borderBottom: "1px solid #f1f5f9",
  color: "#0f172a",
};

const validBadgeStyle: CSSProperties = {
  color: "#166534",
  fontWeight: 800,
};

const invalidBadgeStyle: CSSProperties = {
  color: "#991b1b",
  fontWeight: 800,
};

const fieldLabelStyle: CSSProperties = {
  display: "block",
  marginTop: 16,
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 800,
  color: "#334155",
};

const fieldInputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid #cbd5e1",
  borderRadius: 12,
  padding: "12px 14px",
  fontSize: 14,
  boxSizing: "border-box",
};

const fieldTextareaStyle: CSSProperties = {
  width: "100%",
  border: "1px solid #cbd5e1",
  borderRadius: 12,
  padding: "12px 14px",
  fontSize: 14,
  lineHeight: 1.6,
  boxSizing: "border-box",
  resize: "vertical",
  fontFamily: "inherit",
};

const summaryCardStyle: CSSProperties = {
  marginTop: 16,
  borderRadius: 12,
  padding: "12px 14px",
  background: "#f0fdfa",
  color: "#0f766e",
  fontWeight: 700,
  fontSize: 13.5,
};

const sendButtonStyle: CSSProperties = {
  marginTop: 18,
  width: "100%",
  border: "none",
  borderRadius: 14,
  padding: "15px 16px",
  background: "#0d9488",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 15,
  cursor: "pointer",
};

const sendProgressCardStyle: CSSProperties = {
  marginTop: 16,
  borderRadius: 16,
  padding: 16,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
};

const sendProgressTopRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  fontWeight: 800,
  color: "#334155",
};

const sendProgressTitleStyle: CSSProperties = {};

const sendProgressCountStyle: CSSProperties = {};

const sendProgressTrackStyle: CSSProperties = {
  marginTop: 10,
  height: 8,
  borderRadius: 999,
  background: "#e2e8f0",
  overflow: "hidden",
};

const sendProgressFillStyle: CSSProperties = {
  height: "100%",
  background: "#0d9488",
  transition: "width 0.2s ease",
};

const sendProgressWarningStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 12.5,
  color: "#b45309",
};
