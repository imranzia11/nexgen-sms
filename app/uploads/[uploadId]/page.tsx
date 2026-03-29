"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";
import { formatFirestoreDateNY } from "../../../lib/date";

type LeadItem = {
  id: string;
  name?: string;
  phone: string;
  rawPhone?: string;
  status?: string;
  sourceFileName?: string;
  createdAtMs: number;
};

type UploadDetails = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  validPhoneRows: number;
  phoneColumn: string;
  uploadedByName: string;
  createdAtLabel: string;
};

function getCreatedAtMs(value: any) {
  try {
    if (!value) return 0;
    if (typeof value?.toDate === "function") {
      return value.toDate().getTime();
    }
    return 0;
  } catch {
    return 0;
  }
}

export default function UploadDetailsPage() {
  const router = useRouter();
  const params = useParams();
  const uploadId = String(params.uploadId || "");

  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [upload, setUpload] = useState<UploadDetails | null>(null);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [deletingLeadId, setDeletingLeadId] = useState("");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.push("/login");
        return;
      }

      const userSnap = await getDoc(doc(db, "users", user.uid));

      if (!userSnap.exists() || userSnap.data().role !== "admin") {
        await signOut(auth);
        router.push("/login");
        return;
      }

      setChecking(false);
      await loadUploadDetails();
    });

    return () => unsub();
  }, [router, uploadId]);

  const loadUploadDetails = async () => {
    try {
      setLoading(true);
      setErrorText("");

      const uploadSnap = await getDoc(doc(db, "uploads", uploadId));
      if (!uploadSnap.exists()) {
        setUpload(null);
        setLeads([]);
        setLoading(false);
        return;
      }

      const uploadData = uploadSnap.data();
      setUpload({
        id: uploadSnap.id,
        fileName: uploadData.fileName || "-",
        status: uploadData.status || "imported",
        totalRows: uploadData.totalRows || 0,
        validPhoneRows: uploadData.validPhoneRows || 0,
        phoneColumn: uploadData.phoneColumn || "-",
        uploadedByName: uploadData.uploadedByName || "-",
        createdAtLabel: formatFirestoreDateNY(uploadData.createdAt),
      });

      const leadQuery = query(
        collection(db, "leads"),
        where("uploadId", "==", uploadId)
      );

      const leadSnap = await getDocs(leadQuery);

      const leadItems: LeadItem[] = leadSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name || "",
          phone: data.phone || "",
          rawPhone: data.rawPhone || "",
          status: data.status || "",
          sourceFileName: data.sourceFileName || "",
          createdAtMs: getCreatedAtMs(data.createdAt),
        };
      });

      leadItems.sort((a, b) => b.createdAtMs - a.createdAtMs);

      setLeads(leadItems);
    } catch (error: any) {
      console.error("Failed to load upload details", error);
      setErrorText(error?.message || "Failed to load imported data.");
      setLeads([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteLead = async (leadId: string) => {
    const ok = window.confirm("Delete this lead?");
    if (!ok) return;

    try {
      setDeletingLeadId(leadId);
      await deleteDoc(doc(db, "leads", leadId));
      setLeads((prev) => prev.filter((lead) => lead.id !== leadId));
    } catch (error: any) {
      alert(error?.message || "Failed to delete lead.");
    } finally {
      setDeletingLeadId("");
    }
  };

  if (checking || loading) {
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
        Loading...
      </main>
    );
  }

  if (!upload) {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: "#f1f5f9",
          color: "#0f172a",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <Link href="/dashboard" style={{ color: "#2563eb", textDecoration: "underline" }}>
            ← Back to Dashboard
          </Link>
          <div
            style={{
              marginTop: 24,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 24,
              padding: 24,
            }}
          >
            Upload not found.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        color: "#0f172a",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "grid", gap: 24 }}>
        <div>
          <Link href="/dashboard" style={{ color: "#2563eb", textDecoration: "underline", fontWeight: 700 }}>
            ← Back to Dashboard
          </Link>
        </div>

        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 800 }}>Imported File Details</h1>
          <p style={{ marginTop: 8, color: "#475569" }}>
            Review all data imported under this file.
          </p>

          <div
            style={{
              marginTop: 24,
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 16,
            }}
          >
            <InfoCard label="File UUID" value={upload.id} />
            <InfoCard label="File Name" value={upload.fileName} />
            <InfoCard label="Imported At" value={upload.createdAtLabel} />
            <InfoCard label="Status" value={upload.status} />
            <InfoCard label="Total Rows" value={String(upload.totalRows)} />
            <InfoCard label="Valid Phone Rows" value={String(upload.validPhoneRows)} />
            <InfoCard label="Phone Column" value={upload.phoneColumn} />
            <InfoCard label="Imported By" value={upload.uploadedByName} />
          </div>
        </div>

        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>Imported Data</h2>
          <p style={{ marginTop: 8, color: "#475569" }}>
            All leads saved for this file import.
          </p>

          {errorText ? (
            <div
              style={{
                marginTop: 24,
                background: "#7f1d1d",
                color: "#fff",
                borderRadius: 12,
                padding: "12px 14px",
                fontSize: 14,
              }}
            >
              {errorText}
            </div>
          ) : null}

          {leads.length === 0 ? (
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
              No rows found for this file.
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
                    <th style={thStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td style={tdStyle}>{lead.name || "-"}</td>
                      <td style={tdStyle}>{lead.phone}</td>
                      <td style={{ ...tdStyle, textTransform: "capitalize" }}>
                        {lead.status || "imported"}
                      </td>
                      <td style={tdStyle}>{lead.sourceFileName || "-"}</td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => handleDeleteLead(lead.id)}
                          disabled={deletingLeadId === lead.id}
                          style={{
                            background: "#dc2626",
                            color: "#fff",
                            border: "none",
                            borderRadius: 10,
                            padding: "10px 14px",
                            fontWeight: 700,
                            cursor: "pointer",
                            opacity: deletingLeadId === lead.id ? 0.6 : 1,
                          }}
                        >
                          {deletingLeadId === lead.id ? "Deleting..." : "Delete"}
                        </button>
                      </td>
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
      <p style={{ marginTop: 10, marginBottom: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
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