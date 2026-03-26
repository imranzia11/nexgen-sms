"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import Papa from "papaparse";
import { auth, db } from "../../lib/firebase";

type RowData = Record<string, string>;

type LeadItem = {
  id: string;
  uploadId?: string;
  name?: string;
  phone: string;
  rawPhone?: string;
  status?: string;
  sourceFileName?: string;
};

type UploadItem = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  validPhoneRows: number;
  createdAtLabel: string;
};

function normalizePhone(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/[^\d+]/g, "");
}

function guessPhoneColumn(headers: string[]) {
  const priorities = [
    "phone",
    "phone_number",
    "phonenumber",
    "mobile",
    "mobile_number",
    "contact",
    "contact_number",
    "number",
    "cell",
    "whatsapp",
  ];

  const normalized = headers.map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, "_")
  );

  for (const target of priorities) {
    const foundIndex = normalized.findIndex(
      (h) => h === target || h.includes(target)
    );
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

function formatFirestoreDate(value: any) {
  try {
    if (!value) return "-";
    if (typeof value?.toDate === "function") {
      return value.toDate().toLocaleString();
    }
    return "-";
  } catch {
    return "-";
  }
}

export default function DashboardPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [checking, setChecking] = useState(true);
  const [adminName, setAdminName] = useState("Admin");

  const [status, setStatus] = useState("");
  const [uploading, setUploading] = useState(false);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [deletingUploadId, setDeletingUploadId] = useState("");

  const [selectedUploadId, setSelectedUploadId] = useState("");
  const [selectedUpload, setSelectedUpload] = useState<UploadItem | null>(null);
  const [selectedLeads, setSelectedLeads] = useState<LeadItem[]>([]);
  const [loadingSelectedLeads, setLoadingSelectedLeads] = useState(false);

  const [message, setMessage] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [sendingSms, setSendingSms] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      const snap = await getDoc(doc(db, "users", user.uid));

      if (!snap.exists() || snap.data().role !== "admin") {
        await signOut(auth);
        router.push("/login");
        return;
      }

      setAdminName(snap.data().name || "Admin");
      setChecking(false);
      await loadUploads();
    });

    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!selectedUploadId) {
      setSelectedUpload(null);
      setSelectedLeads([]);
      return;
    }

    const upload = uploads.find((u) => u.id === selectedUploadId) || null;
    setSelectedUpload(upload);
    void loadLeadsForUpload(selectedUploadId);
  }, [selectedUploadId, uploads]);

  const loadUploads = async () => {
    try {
      setLoadingUploads(true);

      const q = query(
        collection(db, "uploads"),
        orderBy("createdAt", "desc"),
        limit(50)
      );

      const snap = await getDocs(q);

      const items: UploadItem[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          fileName: data.fileName || "-",
          status: data.status || "imported",
          totalRows: data.totalRows || 0,
          validPhoneRows: data.validPhoneRows || 0,
          createdAtLabel: formatFirestoreDate(data.createdAt),
        };
      });

      setUploads(items);

      if (!selectedUploadId && items.length > 0) {
        setSelectedUploadId(items[0].id);
      }
    } catch (error) {
      console.error("Failed to load uploads", error);
    } finally {
      setLoadingUploads(false);
    }
  };

  const loadLeadsForUpload = async (uploadId: string) => {
    try {
      setLoadingSelectedLeads(true);

      const q = query(collection(db, "leads"), where("uploadId", "==", uploadId));
      const snap = await getDocs(q);

      const items: LeadItem[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          uploadId: data.uploadId || "",
          name: data.name || "",
          phone: data.phone || "",
          rawPhone: data.rawPhone || "",
          status: data.status || "",
          sourceFileName: data.sourceFileName || "",
        };
      });

      setSelectedLeads(items);
    } catch (error) {
      console.error("Failed to load leads for upload", error);
      setSelectedLeads([]);
    } finally {
      setLoadingSelectedLeads(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    router.push("/login");
  };

  const handlePickFile = () => {
    fileInputRef.current?.click();
  };

  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const user = auth.currentUser;
    const file = event.target.files?.[0];

    if (!user) {
      setStatus("You are not signed in.");
      return;
    }

    if (!file) return;

    setUploading(true);
    setStatus("Reading CSV...");

    Papa.parse<RowData>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const parsedRows = (results.data || []).filter((row) =>
            Object.values(row || {}).some(
              (value) => String(value || "").trim() !== ""
            )
          ) as RowData[];

          const detectedHeaders =
            results.meta.fields?.filter((field) => String(field).trim() !== "") ||
            [];

          if (!detectedHeaders.length) {
            setStatus("No CSV headers found.");
            setUploading(false);
            return;
          }

          const phoneColumn = guessPhoneColumn(detectedHeaders);
          const validPhoneRows = parsedRows.filter((row) =>
            normalizePhone(row[phoneColumn] || "")
          ).length;

          const uploadRef = await addDoc(collection(db, "uploads"), {
            fileName: file.name,
            uploadedBy: user.uid,
            uploadedByName: adminName,
            phoneColumn,
            totalRows: parsedRows.length,
            validPhoneRows,
            status: "imported",
            createdAt: serverTimestamp(),
          });

          let imported = 0;

          for (const row of parsedRows) {
            const rawPhone = String(row[phoneColumn] || "");
            const normalizedPhone = normalizePhone(rawPhone);
            const detectedName = String(guessNameFromRow(row) || "").trim();

            if (!normalizedPhone) continue;

            await addDoc(collection(db, "leads"), {
              uploadId: uploadRef.id,
              uploadedBy: user.uid,
              name: detectedName,
              phone: normalizedPhone,
              rawPhone,
              status: "imported",
              sourceFileName: file.name,
              createdAt: serverTimestamp(),
            });

            imported += 1;
          }

          setStatus(`Import complete. ${imported} leads saved to file ${file.name}.`);
          await loadUploads();
          setSelectedUploadId(uploadRef.id);
        } catch (error: any) {
          setStatus(error?.message || "Import failed.");
        } finally {
          setUploading(false);
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
        }
      },
      error: (error) => {
        setStatus(`CSV read failed: ${error.message}`);
        setUploading(false);
      },
    });
  };

  const handleDeleteUpload = async (uploadId: string) => {
    const ok = window.confirm(
      "Delete this file record only? Leads under it will remain unless deleted separately."
    );
    if (!ok) return;

    try {
      setDeletingUploadId(uploadId);
      await deleteDoc(doc(db, "uploads", uploadId));
      setUploads((prev) => prev.filter((upload) => upload.id !== uploadId));

      if (selectedUploadId === uploadId) {
        setSelectedUploadId("");
        setSelectedUpload(null);
        setSelectedLeads([]);
      }
    } catch (error: any) {
      alert(error?.message || "Failed to delete file.");
    } finally {
      setDeletingUploadId("");
    }
  };

  const handleSendSms = async () => {
    const user = auth.currentUser;

    if (!user) {
      setStatus("You are not signed in.");
      return;
    }

    if (!selectedUploadId || !selectedUpload) {
      setStatus("Please select a file first.");
      return;
    }

    if (!message.trim()) {
      setStatus("Please write an SMS message.");
      return;
    }

    if (!selectedLeads.length) {
      setStatus("No leads found in selected file.");
      return;
    }

    setSendingSms(true);
    setStatus("Sending SMS...");

    try {
      const res = await fetch("/api/send-sms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          campaignName: campaignName.trim() || `Campaign for ${selectedUpload.fileName}`,
          fileId: selectedUploadId,
          fileName: selectedUpload.fileName,
          message: message.trim(),
          leads: selectedLeads.map((lead) => ({
            name: lead.name || "",
            phone: lead.phone || "",
          })),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus(data.error || "Failed to send SMS.");
        return;
      }

      await addDoc(collection(db, "campaigns"), {
        uploadId: selectedUploadId,
        fileName: selectedUpload.fileName,
        name: campaignName.trim() || `Campaign for ${selectedUpload.fileName}`,
        message: message.trim(),
        totalRecipients: selectedLeads.length,
        successCount: data.success || 0,
        failedCount: data.failed || 0,
        status: data.failed > 0 ? "completed_with_failures" : "completed",
        createdBy: user.uid,
        createdByName: adminName,
        createdAt: serverTimestamp(),
      });

      for (const result of data.results || []) {
        await addDoc(collection(db, "messages"), {
          uploadId: selectedUploadId,
          to: result.phone || "",
          name: result.name || "",
          body: message.trim(),
          status: result.ok ? result.status || "sent" : "failed",
          twilioSid: result.sid || "",
          error: result.error || "",
          code: result.code ?? null,
          sourceFileName: selectedUpload.fileName,
          createdAt: serverTimestamp(),
        });
      }

      setStatus(
        `SMS finished. Sent: ${data.success}, Failed: ${data.failed}, Total: ${data.total}.`
      );
      setCampaignName("");
      setMessage("");
    } catch (error: any) {
      console.error(error);
      setStatus(error?.message || "Unexpected error while sending SMS.");
    } finally {
      setSendingSms(false);
    }
  };

  if (checking) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f1f5f9",
          color: "#0f172a",
        }}
      >
        Checking access...
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        color: "#0f172a",
        padding: "24px",
      }}
    >
      <div style={{ maxWidth: 1280, margin: "0 auto", display: "grid", gap: 24 }}>
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 36, fontWeight: 800 }}>
              Welcome, {adminName}
            </h1>
            <p style={{ marginTop: 8, marginBottom: 0, color: "#475569", fontSize: 18 }}>
              Nexgen SMS admin portal
            </p>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link
              href="/replies"
              style={{
                background: "#2563eb",
                color: "#fff",
                textDecoration: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
              }}
            >
              Replies
            </Link>

            <button
              onClick={handleLogout}
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Logout
            </button>
          </div>
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>
                Upload File
              </h2>
              <p style={{ marginTop: 8, marginBottom: 0, color: "#475569" }}>
                Choose a CSV and it will be imported automatically.
              </p>
            </div>

            <button
              onClick={handlePickFile}
              disabled={uploading}
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
                cursor: "pointer",
                opacity: uploading ? 0.6 : 1,
              }}
            >
              {uploading ? "Uploading..." : "Choose CSV"}
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvUpload}
            style={{ display: "none" }}
          />

          {status ? (
            <div
              style={{
                marginTop: 20,
                background: "#0f172a",
                color: "#fff",
                borderRadius: 12,
                padding: "12px 14px",
                fontSize: 14,
              }}
            >
              {status}
            </div>
          ) : null}
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>
                Imported Files
              </h2>
              <p style={{ marginTop: 8, color: "#475569" }}>
                Select a file, then send SMS from the portal below.
              </p>
            </div>

            <button
              onClick={loadUploads}
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "12px 18px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Refresh Files
            </button>
          </div>

          {loadingUploads ? (
            <div
              style={{
                marginTop: 24,
                border: "2px dashed #cbd5e1",
                borderRadius: 18,
                padding: 32,
                textAlign: "center",
                color: "#64748b",
                background: "#f8fafc",
              }}
            >
              Loading files...
            </div>
          ) : uploads.length === 0 ? (
            <div
              style={{
                marginTop: 24,
                border: "2px dashed #cbd5e1",
                borderRadius: 18,
                padding: 32,
                textAlign: "center",
                color: "#64748b",
                background: "#f8fafc",
              }}
            >
              No imported files yet.
            </div>
          ) : (
            <div style={{ marginTop: 24, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Select</th>
                    <th style={thStyle}>File UUID</th>
                    <th style={thStyle}>File Name</th>
                    <th style={thStyle}>Imported At</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Lead Count</th>
                    <th style={thStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {uploads.map((upload) => {
                    const selected = selectedUploadId === upload.id;

                    return (
                      <tr
                        key={upload.id}
                        style={{
                          background: selected ? "#eef6ff" : "transparent",
                        }}
                      >
                        <td style={tdStyle}>
                          <button
                            onClick={() => setSelectedUploadId(upload.id)}
                            style={{
                              background: selected ? "#2563eb" : "#000",
                              color: "#fff",
                              border: "none",
                              borderRadius: 10,
                              padding: "10px 14px",
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            {selected ? "Selected" : "Select"}
                          </button>
                        </td>
                        <td style={tdStyle}>{upload.id}</td>
                        <td style={tdStyle}>{upload.fileName}</td>
                        <td style={tdStyle}>{upload.createdAtLabel}</td>
                        <td style={{ ...tdStyle, textTransform: "capitalize" }}>
                          {upload.status || "imported"}
                        </td>
                        <td style={tdStyle}>{upload.validPhoneRows}</td>
                        <td style={tdStyle}>
                          <button
                            onClick={() => handleDeleteUpload(upload.id)}
                            disabled={deletingUploadId === upload.id}
                            style={{
                              background: "#dc2626",
                              color: "#fff",
                              border: "none",
                              borderRadius: 10,
                              padding: "10px 14px",
                              fontWeight: 700,
                              cursor: "pointer",
                              opacity: deletingUploadId === upload.id ? 0.6 : 1,
                            }}
                          >
                            {deletingUploadId === upload.id ? "Deleting..." : "Delete"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>
            SMS Portal
          </h2>
          <p style={{ marginTop: 8, color: "#475569" }}>
            Select a file above, then write the SMS and send it for all leads in that file.
          </p>

          <div
            style={{
              marginTop: 24,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 16,
            }}
          >
            <InfoCard label="Selected File" value={selectedUpload?.fileName || "-"} />
            <InfoCard label="Selected File UUID" value={selectedUpload?.id || "-"} />
            <InfoCard label="Recipients" value={String(selectedLeads.length)} />
          </div>

          <div style={{ marginTop: 24 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontSize: 14,
                fontWeight: 600,
                color: "#334155",
              }}
            >
              Campaign name
            </label>
            <input
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="Example: March promo batch"
              style={{
                width: "100%",
                borderRadius: 14,
                border: "1px solid #cbd5e1",
                padding: "14px 16px",
                background: "#fff",
                color: "#0f172a",
                fontSize: 16,
              }}
            />
          </div>

          <div style={{ marginTop: 20 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontSize: 14,
                fontWeight: 600,
                color: "#334155",
              }}
            >
              SMS message
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write your SMS here..."
              rows={6}
              style={{
                width: "100%",
                borderRadius: 14,
                border: "1px solid #cbd5e1",
                padding: "14px 16px",
                background: "#fff",
                color: "#0f172a",
                fontSize: 16,
                resize: "vertical",
              }}
            />
          </div>

          <div
            style={{
              marginTop: 20,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              onClick={handleSendSms}
              disabled={
                sendingSms ||
                !selectedUploadId ||
                !selectedLeads.length ||
                !message.trim()
              }
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "14px 22px",
                fontWeight: 700,
                cursor: "pointer",
                opacity:
                  sendingSms ||
                  !selectedUploadId ||
                  !selectedLeads.length ||
                  !message.trim()
                    ? 0.5
                    : 1,
              }}
            >
              {sendingSms ? "Sending..." : "Send SMS for Selected File"}
            </button>

            {selectedUploadId ? (
              <span style={{ color: "#475569", fontSize: 14 }}>
                Target file: <strong>{selectedUpload?.fileName || selectedUploadId}</strong>
              </span>
            ) : (
              <span style={{ color: "#475569", fontSize: 14 }}>
                No file selected
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>
                Leads in Selected File
              </h2>
              <p style={{ marginTop: 8, color: "#475569" }}>
                Numbers that will receive the SMS from the selected file.
              </p>
            </div>

            <button
              onClick={() => selectedUploadId && loadLeadsForUpload(selectedUploadId)}
              style={{
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "12px 18px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Refresh Selected Leads
            </button>
          </div>

          {loadingSelectedLeads ? (
            <div
              style={{
                marginTop: 24,
                border: "2px dashed #cbd5e1",
                borderRadius: 18,
                padding: 32,
                textAlign: "center",
                color: "#64748b",
                background: "#f8fafc",
              }}
            >
              Loading selected leads...
            </div>
          ) : !selectedUploadId ? (
            <div
              style={{
                marginTop: 24,
                border: "2px dashed #cbd5e1",
                borderRadius: 18,
                padding: 32,
                textAlign: "center",
                color: "#64748b",
                background: "#f8fafc",
              }}
            >
              Select a file above first.
            </div>
          ) : selectedLeads.length === 0 ? (
            <div
              style={{
                marginTop: 24,
                border: "2px dashed #cbd5e1",
                borderRadius: 18,
                padding: 32,
                textAlign: "center",
                color: "#64748b",
                background: "#f8fafc",
              }}
            >
              No leads found in selected file.
            </div>
          ) : (
            <div style={{ marginTop: 24, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Phone</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Source File</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedLeads.map((lead) => (
                    <tr key={lead.id}>
                      <td style={tdStyle}>{lead.name || "-"}</td>
                      <td style={tdStyle}>{lead.phone}</td>
                      <td style={{ ...tdStyle, textTransform: "capitalize" }}>
                        {lead.status || "imported"}
                      </td>
                      <td style={tdStyle}>{lead.sourceFileName || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 18,
        padding: 16,
      }}
    >
      <p style={{ margin: 0, fontSize: 14, color: "#64748b" }}>{label}</p>
      <p
        style={{
          marginTop: 10,
          marginBottom: 0,
          fontSize: 18,
          fontWeight: 700,
          color: "#0f172a",
          wordBreak: "break-word",
        }}
      >
        {value}
      </p>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 14px",
  background: "#f8fafc",
  color: "#334155",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 14,
};

const tdStyle: React.CSSProperties = {
  padding: "12px 14px",
  color: "#0f172a",
  borderBottom: "1px solid #f1f5f9",
  fontSize: 14,
};