"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import Papa from "papaparse";
import { auth, db } from "../../lib/firebase";
import { formatFirestoreDateNY } from "../../lib/date";

type RowData = Record<string, string>;

type LeadItem = {
  id: string;
  uploadId?: string;
  name?: string;
  phone: string;
  rawPhone?: string;
  status?: string;
  validationNote?: string;
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

type UploadItemWithSort = UploadItem & {
  createdAtMs: number;
};

type ToastType = "success" | "error" | "info";

const DEFAULT_SMS_MESSAGE =
  "Quick question - does your business need extra capital right now? We can approve $10K-$500K within hours. Reply STOP to opt out, Reply YES to get Funds.";

function getUSPhoneValidation(raw: string) {
  const original = String(raw || "").trim();

  if (!original) {
    return {
      valid: false,
      normalized: "",
      reason: "Format does not match US +1XXXXXXXXXX",
    };
  }

  const digits = original.replace(/\D/g, "");

  if (original.startsWith("+1")) {
    if (digits.length === 11 && digits.startsWith("1")) {
      return {
        valid: true,
        normalized: `+${digits}`,
        reason: "Valid US number",
      };
    }

    return {
      valid: false,
      normalized: "",
      reason: "Format does not match US +1XXXXXXXXXX",
    };
  }

  if (digits.length === 10) {
    return {
      valid: true,
      normalized: `+1${digits}`,
      reason: "Valid US number",
    };
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return {
      valid: true,
      normalized: `+1${digits.slice(1)}`,
      reason: "Valid US number",
    };
  }

  return {
    valid: false,
    normalized: "",
    reason: "Format does not match US +1XXXXXXXXXX",
  };
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

function truncateMiddle(value: string, start = 8, end = 6) {
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function statusChipTone(status?: string) {
  const value = String(status || "").toLowerCase();

  if (
    value.includes("completed") ||
    value.includes("sent") ||
    value.includes("success") ||
    value.includes("verified")
  ) {
    return {
      bg: "rgba(16, 185, 129, 0.12)",
      text: "#059669",
      border: "rgba(16, 185, 129, 0.25)",
    };
  }

  if (
    value.includes("failed") ||
    value.includes("error") ||
    value.includes("unverified")
  ) {
    return {
      bg: "rgba(239, 68, 68, 0.12)",
      text: "#dc2626",
      border: "rgba(239, 68, 68, 0.25)",
    };
  }

  if (value.includes("import")) {
    return {
      bg: "rgba(59, 130, 246, 0.12)",
      text: "#2563eb",
      border: "rgba(59, 130, 246, 0.25)",
    };
  }

  return {
    bg: "rgba(245, 158, 11, 0.12)",
    text: "#b45309",
    border: "rgba(245, 158, 11, 0.25)",
  };
}

function getCreatedAtMs(value: any) {
  try {
    if (!value) return 0;
    if (typeof value?.toDate === "function") {
      return value.toDate().getTime();
    }
    if (typeof value?.seconds === "number") {
      return value.seconds * 1000;
    }
    return 0;
  } catch {
    return 0;
  }
}

export default function DashboardPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [checking, setChecking] = useState(true);
  const [userName, setUserName] = useState("User");
  const [profileUid, setProfileUid] = useState("");

  const [uploading, setUploading] = useState(false);
  const [sendingSms, setSendingSms] = useState(false);
  const [sendingSingleSms, setSendingSingleSms] = useState(false);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [deletingUploadId, setDeletingUploadId] = useState("");

  const [selectedUploadId, setSelectedUploadId] = useState("");
  const [selectedUpload, setSelectedUpload] = useState<UploadItem | null>(null);
  const [selectedLeads, setSelectedLeads] = useState<LeadItem[]>([]);
  const [loadingSelectedLeads, setLoadingSelectedLeads] = useState(false);

  const [message, setMessage] = useState(DEFAULT_SMS_MESSAGE);
  const [campaignName, setCampaignName] = useState("");
  const [singlePhoneNumber, setSinglePhoneNumber] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [leadSearch, setLeadSearch] = useState("");

  const [toastOpen, setToastOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState<ToastType>("info");

  const isBusy = checking || uploading || sendingSms || sendingSingleSms;

  const showToast = (msg: string, type: ToastType = "info") => {
    setToastMessage(msg);
    setToastType(type);
    setToastOpen(true);

    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToastOpen(false);
    }, 5000);
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
        await loadUploads(user.uid);
      } catch (error) {
        console.error("Failed to validate user access", error);
        await signOut(auth).catch(() => {});
        router.push("/login");
      }
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

  const loadUploads = async (uid?: string) => {
    try {
      setLoadingUploads(true);

      const currentUid = uid || profileUid || auth.currentUser?.uid;
      if (!currentUid) {
        setUploads([]);
        return;
      }

      const q = query(
        collection(db, "uploads"),
        where("ownerUid", "==", currentUid)
      );

      const snap = await getDocs(q);

      const items: UploadItem[] = snap.docs
        .map((d) => {
          const data = d.data();
          const row: UploadItemWithSort = {
            id: d.id,
            fileName: data.fileName || "-",
            status: data.status || "imported",
            totalRows: Number(data.totalRows || 0),
            validPhoneRows: Number(data.validPhoneRows || 0),
            createdAtLabel: formatFirestoreDateNY(data.createdAt),
            createdAtMs: getCreatedAtMs(data.createdAt),
          };
          return row;
        })
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map(({ createdAtMs, ...rest }) => rest);

      setUploads(items);

      if (!selectedUploadId && items.length > 0) {
        setSelectedUploadId(items[0].id);
      } else if (
        selectedUploadId &&
        !items.some((x) => x.id === selectedUploadId)
      ) {
        setSelectedUploadId(items[0]?.id || "");
      }
    } catch (error) {
      console.error("Failed to load uploads", error);
      showToast("Failed to load imported files.", "error");
    } finally {
      setLoadingUploads(false);
    }
  };

  const loadLeadsForUpload = async (uploadId: string) => {
    try {
      setLoadingSelectedLeads(true);

      const currentUid = profileUid || auth.currentUser?.uid;
      if (!currentUid) {
        setSelectedLeads([]);
        return;
      }

      const q = query(
        collection(db, "leads"),
        where("ownerUid", "==", currentUid),
        where("uploadId", "==", uploadId)
      );

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
          validationNote: data.validationNote || "",
          sourceFileName: data.sourceFileName || "",
        };
      });

      setSelectedLeads(items);
    } catch (error) {
      console.error("Failed to load leads for upload", error);
      setSelectedLeads([]);
      showToast("Failed to load leads for selected file.", "error");
    } finally {
      setLoadingSelectedLeads(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth).catch(() => {});
    router.push("/login");
  };

  const handleContactSupport = () => {
    window.open("https://wa.me/971523480839", "_blank", "noopener,noreferrer");
  };

  const handleBlacklistedNumbers = () => {
    router.push("/blacklisted");
  };

  const handlePickFile = () => {
    fileInputRef.current?.click();
  };

  const handleCsvUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const user = auth.currentUser;
    const file = event.target.files?.[0];

    if (!user) {
      showToast("You are not signed in.", "error");
      return;
    }

    if (!file) return;

    setUploading(true);

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
            showToast("No CSV headers found.", "error");
            setUploading(false);
            return;
          }

          const phoneColumn = guessPhoneColumn(detectedHeaders);
          const validPhoneRows = parsedRows.filter((row) => {
            const validation = getUSPhoneValidation(row[phoneColumn] || "");
            return validation.valid;
          }).length;

          const uploadRef = await addDoc(collection(db, "uploads"), {
            fileName: file.name,
            uploadedBy: user.uid,
            ownerUid: user.uid,
            uploadedByName: userName,
            phoneColumn,
            totalRows: parsedRows.length,
            validPhoneRows,
            status: "imported",
            createdAt: serverTimestamp(),
          });

          let imported = 0;

          for (const row of parsedRows) {
            const rawPhone = String(row[phoneColumn] || "");
            const validation = getUSPhoneValidation(rawPhone);
            const detectedName = String(guessNameFromRow(row) || "").trim();

            await addDoc(collection(db, "leads"), {
              uploadId: uploadRef.id,
              uploadedBy: user.uid,
              ownerUid: user.uid,
              name: detectedName,
              phone: validation.valid ? validation.normalized : rawPhone,
              rawPhone,
              status: validation.valid ? "verified" : "unverified",
              validationNote: validation.valid
                ? "Valid US number"
                : validation.reason,
              sourceFileName: file.name,
              createdAt: serverTimestamp(),
            });

            if (validation.valid) {
              imported += 1;
            }
          }

          await loadUploads(user.uid);
          setSelectedUploadId(uploadRef.id);
          showToast(
            `Import complete. ${imported} verified US leads saved from ${file.name}.`,
            "success"
          );
        } catch (error: any) {
          showToast(error?.message || "Import failed.", "error");
        } finally {
          setUploading(false);
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
        }
      },
      error: (error) => {
        showToast(`CSV read failed: ${error.message}`, "error");
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

      showToast("File record deleted.", "success");
    } catch (error: any) {
      showToast(error?.message || "Failed to delete file.", "error");
    } finally {
      setDeletingUploadId("");
    }
  };

  const handleSendSms = async () => {
    const user = auth.currentUser;

    if (!user) {
      showToast("You are not signed in.", "error");
      return;
    }

    if (!selectedUploadId || !selectedUpload) {
      showToast("Please select a file first.", "error");
      return;
    }

    if (!message.trim()) {
      showToast("Please write an SMS message.", "error");
      return;
    }

    const verifiedLeads = selectedLeads.filter(
      (lead) => String(lead.status || "").toLowerCase() === "verified"
    );

    if (!verifiedLeads.length) {
      showToast("No verified US leads found in selected file.", "error");
      return;
    }

    setSendingSms(true);

    try {
      const idToken = await user.getIdToken();

      const res = await fetch("/api/send-sms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          campaignName:
            campaignName.trim() || `Campaign for ${selectedUpload.fileName}`,
          fileId: selectedUploadId,
          fileName: selectedUpload.fileName,
          message: message.trim(),
          leads: verifiedLeads.map((lead) => ({
            name: lead.name || "",
            phone: lead.phone || "",
          })),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        showToast(data.error || "Failed to send SMS.", "error");
        return;
      }

      await addDoc(collection(db, "campaigns"), {
        ownerUid: user.uid,
        createdBy: user.uid,
        uploadId: selectedUploadId,
        fileName: selectedUpload.fileName,
        name: campaignName.trim() || `Campaign for ${selectedUpload.fileName}`,
        message: message.trim(),
        totalRecipients: verifiedLeads.length,
        successCount: data.success || 0,
        failedCount: data.failed || 0,
        status: data.failed > 0 ? "completed_with_failures" : "completed",
        createdByName: userName,
        createdAt: serverTimestamp(),
      });

      showToast(
        `SMS finished. Sent: ${data.success}, Failed: ${data.failed}, Total Verified Sent Attempted: ${data.total}.`,
        data.failed > 0 ? "info" : "success"
      );

      setCampaignName("");
      setMessage(DEFAULT_SMS_MESSAGE);
    } catch (error: any) {
      console.error(error);
      showToast(error?.message || "Unexpected error while sending SMS.", "error");
    } finally {
      setSendingSms(false);
    }
  };

  const handleSendSingleSms = async () => {
    const user = auth.currentUser;

    if (!user) {
      showToast("You are not signed in.", "error");
      return;
    }

    if (!message.trim()) {
      showToast("Please write an SMS message first.", "error");
      return;
    }

    const validation = getUSPhoneValidation(singlePhoneNumber);

    if (!validation.valid) {
      showToast("Please enter one valid US phone number.", "error");
      return;
    }

    setSendingSingleSms(true);

    try {
      const idToken = await user.getIdToken();

      const res = await fetch("/api/send-sms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          campaignName: `Direct Send ${new Date().toLocaleString()}`,
          fileId: "",
          fileName: "Single USA Number",
          message: message.trim(),
          leads: [
            {
              name: "",
              phone: validation.normalized,
            },
          ],
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        showToast(data.error || "Failed to send SMS to the number.", "error");
        return;
      }

      await addDoc(collection(db, "campaigns"), {
        ownerUid: user.uid,
        createdBy: user.uid,
        uploadId: "",
        fileName: "Single USA Number",
        name: `Direct Send ${new Date().toLocaleString()}`,
        message: message.trim(),
        totalRecipients: 1,
        successCount: data.success || 0,
        failedCount: data.failed || 0,
        status: data.failed > 0 ? "completed_with_failures" : "completed",
        createdByName: userName,
        createdAt: serverTimestamp(),
        isDirectSend: true,
        directPhone: validation.normalized,
      });

      showToast(
        `Message sent. Sent: ${data.success}, Failed: ${data.failed}.`,
        data.failed > 0 ? "info" : "success"
      );

      setSinglePhoneNumber("");
    } catch (error: any) {
      console.error(error);
      showToast(
        error?.message || "Unexpected error while sending to the number.",
        "error"
      );
    } finally {
      setSendingSingleSms(false);
    }
  };

  const filteredUploads = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return uploads;

    return uploads.filter((item) => {
      return (
        item.fileName.toLowerCase().includes(term) ||
        item.id.toLowerCase().includes(term) ||
        item.status.toLowerCase().includes(term)
      );
    });
  }, [uploads, searchTerm]);

  const filteredLeads = useMemo(() => {
    const term = leadSearch.trim().toLowerCase();
    if (!term) return selectedLeads;

    return selectedLeads.filter((lead) => {
      return (
        String(lead.name || "").toLowerCase().includes(term) ||
        String(lead.phone || "").toLowerCase().includes(term) ||
        String(lead.status || "").toLowerCase().includes(term) ||
        String(lead.validationNote || "").toLowerCase().includes(term) ||
        String(lead.sourceFileName || "").toLowerCase().includes(term)
      );
    });
  }, [selectedLeads, leadSearch]);

  const totalRecipients = selectedLeads.filter(
    (lead) => String(lead.status || "").toLowerCase() === "verified"
  ).length;
  const totalUploads = uploads.length;
  const totalValidNumbers = uploads.reduce(
    (sum, item) => sum + (item.validPhoneRows || 0),
    0
  );

  if (checking) {
    return (
      <main style={loadingPageStyle}>
        <GlobalStyles />
        <div style={loadingCardStyle}>
          <div style={spinnerStyle} />
          <p
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 700,
              color: "#e6fffb",
            }}
          >
            Checking account access...
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <GlobalStyles />

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
                ? "Success"
                : toastType === "error"
                ? "Something went wrong"
                : "System update"}
            </div>
            <div style={toastMessageStyle}>{toastMessage}</div>
          </div>
          <button onClick={() => setToastOpen(false)} style={toastCloseStyle}>
            ×
          </button>
        </div>
      ) : null}

      {isBusy ? (
        <div style={busyOverlayStyle}>
          <div style={busyCardStyle}>
            <div style={busySpinnerRingStyle}>
              <div style={busySpinnerInnerStyle} />
            </div>

            <h3 style={busyTitleStyle}>
              {uploading
                ? "Uploading and importing file..."
                : sendingSms
                ? "Sending SMS campaign..."
                : sendingSingleSms
                ? "Sending to one USA number..."
                : "Please wait..."}
            </h3>

            <p style={busyTextStyle}>
              {uploading
                ? "The system is reading your CSV, validating US numbers, and saving leads."
                : sendingSms
                ? "The system is processing verified recipients and sending messages. Please do not close this page."
                : sendingSingleSms
                ? "The system is sending your message directly to the entered USA number. Please do not close this page."
                : "The system is busy."}
            </p>
          </div>
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

              <div style={sidebarRepliesWrapStyle}>
                <Link href="/replies" style={sidebarRepliesCardStyle}>
                  <div style={sidebarRepliesIconStyle}>↩</div>
                  <div>
                    <div style={sidebarRepliesTitleStyle}>Replies</div>
                    <div style={sidebarRepliesTextStyle}>
                      Open incoming messages
                    </div>
                  </div>
                </Link>
              </div>

              <div style={sidebarRepliesWrapStyle}>
                <button
                  onClick={handleBlacklistedNumbers}
                  style={sidebarSupportCardStyle}
                  type="button"
                >
                  <div style={sidebarSupportIconStyle}>⛔</div>
                  <div style={{ textAlign: "left" }}>
                    <div style={sidebarRepliesTitleStyle}>
                      Black Listed Numbers
                    </div>
                    <div style={sidebarRepliesTextStyle}>
                      View STOP opt-out numbers
                    </div>
                  </div>
                </button>
              </div>

              <div style={sidebarRepliesWrapStyle}>
                <button
                  onClick={handleContactSupport}
                  style={sidebarSupportCardStyle}
                  type="button"
                >
                  <div style={sidebarSupportIconStyle}>?</div>
                  <div style={{ textAlign: "left" }}>
                    <div style={sidebarRepliesTitleStyle}>Contact Support</div>
                    <div style={sidebarRepliesTextStyle}>
                      Get help for admin portal setup
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div style={sidebarBottomLogoutWrapStyle}>
              <div style={{ display: "grid", gap: 12 }}>
                <Link href="/logs" style={sidebarSecondaryLinkButtonStyle}>
                  Logs
                </Link>

                <button onClick={handleLogout} style={sidebarLogoutButtonStyle}>
                  Logout
                </button>
              </div>
            </div>
          </aside>

          <section style={contentStyle}>
            <div style={heroCardStyle}>
              <div style={heroOverlayStyle} />
              <div style={heroInnerStyle}>
                <div>
                  <div style={heroBadgeStyle}>Premium User Workspace</div>
                  <h1 style={heroTitleStyle}>Fintech SMS Dashboard</h1>
                  <p style={heroTextStyle}>
                    Upload lead files, review imported recipients, validate US
                    numbers, and launch campaigns from one clean control center.
                  </p>
                </div>

                <div style={heroTopControlsStyle}>
                  <div style={searchBarStyle}>
                    <span style={{ fontSize: 16, opacity: 0.8 }}>⌕</span>
                    <input
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Search files by name, uuid, or status"
                      style={searchInputStyle}
                    />
                  </div>

                  <button
                    onClick={handlePickFile}
                    disabled={uploading || sendingSms || sendingSingleSms}
                    style={{
                      ...heroPrimaryButtonStyle,
                      opacity:
                        uploading || sendingSms || sendingSingleSms ? 0.7 : 1,
                      cursor:
                        uploading || sendingSms || sendingSingleSms
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {uploading ? "Uploading..." : "Upload CSV"}
                  </button>
                </div>

                <div style={statsGridStyle}>
                  <StatCard
                    label="Imported Files"
                    value={String(totalUploads)}
                    accent="rgba(255,255,255,0.18)"
                  />
                  <StatCard
                    label="Valid Numbers"
                    value={String(totalValidNumbers)}
                    accent="rgba(255,255,255,0.18)"
                  />
                  <StatCard
                    label="Selected Recipients"
                    value={String(totalRecipients)}
                    accent="rgba(255,255,255,0.18)"
                  />
                  <StatCard
                    label="Selected File"
                    value={selectedUpload?.fileName || "-"}
                    accent="rgba(255,255,255,0.18)"
                    compact
                  />
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvUpload}
                style={{ display: "none" }}
              />
            </div>

            <div style={mainGridStyle}>
              <div style={leftColumnStyle}>
                <section style={panelStyle}>
                  <div style={panelHeaderStyle}>
                    <div>
                      <h2 style={panelTitleStyle}>Imported Files</h2>
                      <p style={panelDescStyle}>
                        Pick one imported file to load all leads into the SMS
                        portal.
                      </p>
                    </div>

                    <button
                      onClick={() => loadUploads()}
                      style={secondaryButtonStyle}
                    >
                      Refresh
                    </button>
                  </div>

                  {loadingUploads ? (
                    <EmptyState text="Loading files..." />
                  ) : filteredUploads.length === 0 ? (
                    <EmptyState text="No imported files found." />
                  ) : (
                    <div style={{ display: "grid", gap: 14 }}>
                      {filteredUploads.map((upload) => {
                        const selected = selectedUploadId === upload.id;
                        const tone = statusChipTone(upload.status);

                        return (
                          <div
                            key={upload.id}
                            style={{
                              ...fileCardStyle,
                              border: selected
                                ? "1px solid rgba(13, 148, 136, 0.45)"
                                : "1px solid rgba(15, 23, 42, 0.06)",
                              boxShadow: selected
                                ? "0 18px 40px rgba(13, 148, 136, 0.14)"
                                : "0 8px 20px rgba(15, 23, 42, 0.05)",
                            }}
                          >
                            <div style={fileCardTopStyle}>
                              <div style={{ minWidth: 0 }}>
                                <div style={fileNameStyle}>
                                  {upload.fileName}
                                </div>
                                <div style={fileMetaStyle}>
                                  UUID: {truncateMiddle(upload.id, 10, 8)}
                                </div>
                              </div>

                              <div
                                style={{
                                  background: tone.bg,
                                  color: tone.text,
                                  border: `1px solid ${tone.border}`,
                                  borderRadius: 999,
                                  padding: "8px 12px",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  textTransform: "capitalize",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {upload.status || "imported"}
                              </div>
                            </div>

                            <div style={fileStatsRowStyle}>
                              <MiniData
                                label="Imported"
                                value={upload.createdAtLabel}
                              />
                              <MiniData
                                label="Rows"
                                value={String(upload.totalRows)}
                              />
                              <MiniData
                                label="Valid Phones"
                                value={String(upload.validPhoneRows)}
                              />
                            </div>

                            <div style={fileActionsStyle}>
                              <button
                                onClick={() => setSelectedUploadId(upload.id)}
                                style={
                                  selected
                                    ? selectedButtonStyle
                                    : primaryButtonStyle
                                }
                              >
                                {selected ? "Selected" : "Select File"}
                              </button>

                              <button
                                onClick={() => handleDeleteUpload(upload.id)}
                                disabled={deletingUploadId === upload.id}
                                style={{
                                  ...dangerButtonStyle,
                                  opacity:
                                    deletingUploadId === upload.id ? 0.65 : 1,
                                }}
                              >
                                {deletingUploadId === upload.id
                                  ? "Deleting..."
                                  : "Delete"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section style={panelStyle}>
                  <div style={panelHeaderStyle}>
                    <div>
                      <h2 style={panelTitleStyle}>Leads in Selected File</h2>
                      <p style={panelDescStyle}>
                        Review all numbers before sending.
                      </p>
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <input
                        value={leadSearch}
                        onChange={(e) => setLeadSearch(e.target.value)}
                        placeholder="Search leads"
                        style={inlineSearchInputStyle}
                      />
                      <button
                        onClick={() =>
                          selectedUploadId && loadLeadsForUpload(selectedUploadId)
                        }
                        style={secondaryButtonStyle}
                      >
                        Refresh
                      </button>
                    </div>
                  </div>

                  {loadingSelectedLeads ? (
                    <EmptyState text="Loading selected leads..." />
                  ) : !selectedUploadId ? (
                    <EmptyState text="Select a file first." />
                  ) : filteredLeads.length === 0 ? (
                    <EmptyState text="No leads found in selected file." />
                  ) : (
                    <div style={tableWrapStyle}>
                      <table style={tableStyle}>
                        <thead>
                          <tr>
                            <th style={thStyle}>Name</th>
                            <th style={thStyle}>Phone</th>
                            <th style={thStyle}>Status</th>
                            <th style={thStyle}>Validation</th>
                            <th style={thStyle}>Source File</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredLeads.map((lead) => {
                            const tone = statusChipTone(lead.status);
                            return (
                              <tr key={lead.id}>
                                <td style={tdStyle}>{lead.name || "-"}</td>
                                <td style={tdStyle}>{lead.phone}</td>
                                <td style={tdStyle}>
                                  <span
                                    style={{
                                      background: tone.bg,
                                      color: tone.text,
                                      border: `1px solid ${tone.border}`,
                                      borderRadius: 999,
                                      padding: "6px 10px",
                                      fontSize: 12,
                                      fontWeight: 700,
                                      textTransform: "capitalize",
                                    }}
                                  >
                                    {lead.status || "-"}
                                  </span>
                                </td>
                                <td style={tdStyle}>
                                  {lead.validationNote || "-"}
                                </td>
                                <td style={tdStyle}>
                                  {lead.sourceFileName || "-"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>

              <div style={rightColumnStyle}>
                <section style={panelStyle}>
                  <div style={panelHeaderStyle}>
                    <div>
                      <h2 style={panelTitleStyle}>SMS Portal</h2>
                      <p style={panelDescStyle}>
                        Create a campaign and send the message to all verified US
                        recipients in the selected file.
                      </p>
                    </div>
                  </div>

                  <div style={composeTopGridStyle}>
                    <InfoPanel
                      label="Selected File"
                      value={selectedUpload?.fileName || "-"}
                    />
                    <InfoPanel
                      label="File UUID"
                      value={selectedUpload?.id || "-"}
                    />
                    <InfoPanel
                      label="Recipients"
                      value={String(totalRecipients)}
                    />
                  </div>

                  <div style={{ marginTop: 18 }}>
                    <label style={fieldLabelStyle}>Campaign Name</label>
                    <input
                      value={campaignName}
                      onChange={(e) => setCampaignName(e.target.value)}
                      placeholder="Example: March Promo Batch"
                      style={fieldInputStyle}
                    />
                  </div>

                  <div style={{ marginTop: 18 }}>
                    <label style={fieldLabelStyle}>SMS Message</label>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={8}
                      style={fieldTextareaStyle}
                    />
                  </div>

                  <div style={messageHintStyle}>
                    <span>Characters:</span>
                    <strong>{message.length}</strong>
                  </div>

                  <div style={sendActionWrapStyle}>
                    <button
                      onClick={handleSendSms}
                      disabled={
                        sendingSms ||
                        uploading ||
                        sendingSingleSms ||
                        !selectedUploadId ||
                        !selectedLeads.some(
                          (lead) =>
                            String(lead.status || "").toLowerCase() ===
                            "verified"
                        ) ||
                        !message.trim()
                      }
                      style={{
                        ...sendButtonStyle,
                        opacity:
                          sendingSms ||
                          uploading ||
                          sendingSingleSms ||
                          !selectedUploadId ||
                          !selectedLeads.some(
                            (lead) =>
                              String(lead.status || "").toLowerCase() ===
                              "verified"
                          ) ||
                          !message.trim()
                            ? 0.55
                            : 1,
                        cursor:
                          sendingSms ||
                          uploading ||
                          sendingSingleSms ||
                          !selectedUploadId ||
                          !selectedLeads.some(
                            (lead) =>
                              String(lead.status || "").toLowerCase() ===
                              "verified"
                          ) ||
                          !message.trim()
                            ? "not-allowed"
                            : "pointer",
                      }}
                    >
                      {sendingSms ? "Sending..." : "Send to Selected File"}
                    </button>

                    <div style={sendHelpTextStyle}>
                      {selectedUploadId
                        ? `Target file: ${
                            selectedUpload?.fileName || selectedUploadId
                          }`
                        : "No file selected"}
                    </div>
                  </div>

                  <section style={singleSendCardStyle}>
                    <div>
                      <h3 style={singleSendTitleStyle}>Send to one USA number</h3>
                      <p style={singleSendTextStyle}>
                        Add one valid US phone number and send this message
                        directly.
                      </p>
                    </div>

                    <div style={{ marginTop: 18 }}>
                      <label style={fieldLabelStyle}>US Phone Number</label>
                      <input
                        value={singlePhoneNumber}
                        onChange={(e) => setSinglePhoneNumber(e.target.value)}
                        placeholder="Example: +16625551234"
                        style={singleSendInputStyle}
                      />
                    </div>

                    <div style={{ marginTop: 18 }}>
                      <button
                        onClick={handleSendSingleSms}
                        disabled={
                          sendingSingleSms ||
                          uploading ||
                          !message.trim() ||
                          !getUSPhoneValidation(singlePhoneNumber).valid
                        }
                        style={{
                          ...singleSendButtonStyle,
                          opacity:
                            sendingSingleSms ||
                            uploading ||
                            !message.trim() ||
                            !getUSPhoneValidation(singlePhoneNumber).valid
                              ? 0.55
                              : 1,
                          cursor:
                            sendingSingleSms ||
                            uploading ||
                            !message.trim() ||
                            !getUSPhoneValidation(singlePhoneNumber).valid
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        {sendingSingleSms ? "Sending..." : "Send to One Number"}
                      </button>
                    </div>
                  </section>
                </section>

                <section style={rightMiniPanelStyle}>
                  <h3 style={miniPanelTitleStyle}>Quick Guide</h3>
                  <div style={guideListStyle}>
                    <GuideItem
                      number="1"
                      text="Upload a CSV file containing lead data."
                    />
                    <GuideItem
                      number="2"
                      text="The system validates US numbers as +1 followed by 10 digits."
                    />
                    <GuideItem
                      number="3"
                      text="Only verified US leads will be used for the campaign."
                    />
                    <GuideItem
                      number="4"
                      text="You can also send directly to one USA number from the quick send box."
                    />
                  </div>
                </section>
              </div>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function GlobalStyles() {
  return (
    <style jsx global>{`
      @keyframes spin {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }

      @keyframes pulseScale {
        0% {
          transform: scale(0.96);
          opacity: 0.85;
        }
        50% {
          transform: scale(1);
          opacity: 1;
        }
        100% {
          transform: scale(0.96);
          opacity: 0.85;
        }
      }

      @keyframes toastIn {
        0% {
          opacity: 0;
          transform: translateY(-18px) scale(0.96);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      input::placeholder,
      textarea::placeholder {
        color: #94a3b8;
      }
    `}</style>
  );
}

function StatCard({
  label,
  value,
  accent,
  compact = false,
}: {
  label: string;
  value: string;
  accent: string;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        background: accent,
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 20,
        padding: "18px 18px",
        backdropFilter: "blur(10px)",
        minHeight: compact ? 88 : 96,
      }}
    >
      <div
        style={{
          color: "rgba(236, 254, 255, 0.72)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          color: "#ffffff",
          fontSize: compact ? 16 : 28,
          fontWeight: 800,
          lineHeight: 1.15,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MiniData({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniDataStyle}>
      <div style={miniDataLabelStyle}>{label}</div>
      <div style={miniDataValueStyle}>{value}</div>
    </div>
  );
}

function InfoPanel({ label, value }: { label: string; value: string }) {
  return (
    <div style={infoPanelStyle}>
      <div style={infoPanelLabelStyle}>{label}</div>
      <div style={infoPanelValueStyle}>{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={emptyStateStyle}>
      <div style={emptyStateIconStyle}>•</div>
      <div style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}>
        {text}
      </div>
    </div>
  );
}

function GuideItem({ number, text }: { number: string; text: string }) {
  return (
    <div style={guideItemStyle}>
      <div style={guideNumberStyle}>{number}</div>
      <div style={guideTextStyle}>{text}</div>
    </div>
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

const sidebarSupportCardStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 26,
  padding: "18px 18px",
  background: "rgba(255,255,255,0.10)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.08)",
  backdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  gap: 14,
  cursor: "pointer",
};

const sidebarRepliesIconStyle: CSSProperties = {
  width: 54,
  height: 54,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontSize: 26,
  fontWeight: 900,
  flexShrink: 0,
};

const sidebarSupportIconStyle: CSSProperties = {
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
  gap: 20,
};

const heroCardStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  borderRadius: 32,
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 48%, #14b8a6 100%)",
  boxShadow: "0 30px 80px rgba(13, 148, 136, 0.28)",
};

const heroOverlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(circle at top right, rgba(255,255,255,0.18), transparent 24%), radial-gradient(circle at bottom left, rgba(255,255,255,0.08), transparent 28%)",
  pointerEvents: "none",
};

const heroInnerStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  padding: 28,
  display: "grid",
  gap: 22,
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
  letterSpacing: 0.3,
};

const heroTitleStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "#ffffff",
  fontSize: 38,
  lineHeight: 1.05,
  fontWeight: 900,
};

const heroTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  maxWidth: 760,
  color: "rgba(236,254,255,0.86)",
  fontSize: 16,
  lineHeight: 1.65,
};

const heroTopControlsStyle: CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  flexWrap: "wrap",
};

const searchBarStyle: CSSProperties = {
  flex: 1,
  minWidth: 260,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 16px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.16)",
  backdropFilter: "blur(10px)",
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "#ffffff",
  fontSize: 15,
};

const heroPrimaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 18,
  padding: "15px 20px",
  background: "#ecfeff",
  color: "#0f766e",
  fontWeight: 900,
  fontSize: 15,
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 14,
};

const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.2fr 0.8fr",
  gap: 20,
  alignItems: "start",
};

const leftColumnStyle: CSSProperties = {
  display: "grid",
  gap: 20,
};

const rightColumnStyle: CSSProperties = {
  display: "grid",
  gap: 20,
};

const panelStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 12px 30px rgba(15,23,42,0.05)",
};

const rightMiniPanelStyle: CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, #f0fdfa 100%)",
  border: "1px solid rgba(13,148,136,0.10)",
  borderRadius: 28,
  padding: 22,
  boxShadow: "0 16px 40px rgba(15,23,42,0.05)",
};

const panelHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 14,
  flexWrap: "wrap",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 900,
  color: "#0f172a",
};

const panelDescStyle: CSSProperties = {
  margin: "8px 0 0 0",
  color: "#64748b",
  fontSize: 14,
  lineHeight: 1.5,
};

const secondaryButtonStyle: CSSProperties = {
  border: "1px solid rgba(15,23,42,0.08)",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontWeight: 800,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#0d9488",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
};

const selectedButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#0f172a",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 14,
  padding: "12px 16px",
  background: "#dc2626",
  color: "#ffffff",
  fontWeight: 800,
  cursor: "pointer",
};

const fileCardStyle: CSSProperties = {
  borderRadius: 22,
  padding: 18,
  background: "linear-gradient(180deg, #ffffff 0%, #fcfffe 100%)",
};

const fileCardTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
  flexWrap: "wrap",
};

const fileNameStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: "#0f172a",
  wordBreak: "break-word",
};

const fileMetaStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: "#64748b",
};

const fileStatsRowStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 12,
};

const miniDataStyle: CSSProperties = {
  borderRadius: 16,
  background: "#f8fafc",
  padding: 12,
  border: "1px solid #eef2f7",
};

const miniDataLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  fontWeight: 700,
};

const miniDataValueStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  color: "#0f172a",
  fontWeight: 800,
  wordBreak: "break-word",
};

const fileActionsStyle: CSSProperties = {
  marginTop: 16,
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const tableWrapStyle: CSSProperties = {
  marginTop: 18,
  overflowX: "auto",
  borderRadius: 20,
  border: "1px solid #eef2f7",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#ffffff",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "14px 16px",
  background: "#f8fafc",
  color: "#475569",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 13,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "14px 16px",
  color: "#0f172a",
  borderBottom: "1px solid #f1f5f9",
  fontSize: 14,
  verticalAlign: "middle",
};

const composeTopGridStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 12,
};

const infoPanelStyle: CSSProperties = {
  borderRadius: 18,
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  padding: 16,
  border: "1px solid #eef2f7",
};

const infoPanelLabelStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  fontWeight: 800,
};

const infoPanelValueStyle: CSSProperties = {
  marginTop: 10,
  color: "#0f172a",
  fontSize: 16,
  fontWeight: 900,
  wordBreak: "break-word",
};

const fieldLabelStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  color: "#334155",
  fontSize: 13,
  fontWeight: 800,
};

const fieldInputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 16,
  border: "1px solid #dbe3ed",
  padding: "14px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 15,
  outline: "none",
};

const fieldTextareaStyle: CSSProperties = {
  width: "100%",
  borderRadius: 18,
  border: "1px solid #dbe3ed",
  padding: "14px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 15,
  resize: "vertical",
  outline: "none",
  minHeight: 180,
};

const messageHintStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  color: "#64748b",
  fontSize: 13,
};

const sendActionWrapStyle: CSSProperties = {
  marginTop: 18,
  display: "grid",
  gap: 12,
};

const sendButtonStyle: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: 18,
  padding: "16px 18px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 16,
  boxShadow: "0 18px 35px rgba(13,148,136,0.24)",
};

const sendHelpTextStyle: CSSProperties = {
  color: "#475569",
  fontSize: 13,
  lineHeight: 1.5,
  wordBreak: "break-word",
};

const miniPanelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 900,
  color: "#0f172a",
};

const guideListStyle: CSSProperties = {
  marginTop: 16,
  display: "grid",
  gap: 12,
};

const guideItemStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
};

const guideNumberStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#ccfbf1",
  color: "#115e59",
  fontWeight: 900,
  fontSize: 14,
  flexShrink: 0,
};

const guideTextStyle: CSSProperties = {
  color: "#334155",
  fontSize: 14,
  lineHeight: 1.6,
  fontWeight: 600,
};

const emptyStateStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 22,
  padding: "34px 18px",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  display: "grid",
  justifyItems: "center",
  gap: 10,
  textAlign: "center",
};

const emptyStateIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: "#e2e8f0",
  color: "#475569",
  fontWeight: 900,
};

const inlineSearchInputStyle: CSSProperties = {
  minWidth: 190,
  borderRadius: 14,
  border: "1px solid #dbe3ed",
  padding: "12px 14px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 14,
  outline: "none",
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
  backdropFilter: "blur(10px)",
};

const spinnerStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.25)",
  borderTop: "3px solid #ffffff",
  animation: "spin 1s linear infinite",
};

const busyOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9998,
  background: "rgba(3, 7, 18, 0.52)",
  backdropFilter: "blur(8px)",
  display: "grid",
  placeItems: "center",
  padding: 24,
};

const busyCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 520,
  borderRadius: 30,
  padding: "34px 28px",
  background: "linear-gradient(135deg, #0f172a 0%, #0b2545 100%)",
  boxShadow: "0 30px 100px rgba(2, 8, 23, 0.45)",
  border: "1px solid rgba(255,255,255,0.08)",
  textAlign: "center",
};

const busySpinnerRingStyle: CSSProperties = {
  width: 96,
  height: 96,
  margin: "0 auto 20px auto",
  borderRadius: "50%",
  border: "8px solid rgba(255,255,255,0.12)",
  borderTop: "8px solid #2dd4bf",
  animation: "spin 1s linear infinite",
  display: "grid",
  placeItems: "center",
};

const busySpinnerInnerStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  background: "#2dd4bf",
  animation: "pulseScale 1.2s ease-in-out infinite",
};

const busyTitleStyle: CSSProperties = {
  margin: 0,
  color: "#ffffff",
  fontSize: 28,
  fontWeight: 900,
  lineHeight: 1.15,
};

const busyTextStyle: CSSProperties = {
  margin: "12px 0 0 0",
  color: "rgba(226, 232, 240, 0.92)",
  fontSize: 15,
  lineHeight: 1.7,
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

const singleSendCardStyle: CSSProperties = {
  marginTop: 20,
  borderRadius: 24,
  padding: 24,
  background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
  border: "1px solid #e2e8f0",
  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.06)",
};

const singleSendTitleStyle: CSSProperties = {
  margin: 0,
  color: "#0f172a",
  fontSize: 24,
  fontWeight: 900,
  lineHeight: 1.1,
};

const singleSendTextStyle: CSSProperties = {
  margin: "10px 0 0 0",
  color: "#64748b",
  fontSize: 15,
  lineHeight: 1.6,
  maxWidth: 520,
};

const singleSendInputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 16,
  border: "1px solid #dbe3ed",
  padding: "16px 16px",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 15,
  outline: "none",
  boxShadow: "none",
};

const singleSendButtonStyle: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: 18,
  padding: "16px 18px",
  background: "linear-gradient(135deg, #0f766e 0%, #0d9488 100%)",
  color: "#ffffff",
  fontWeight: 900,
  fontSize: 17,
  boxShadow: "0 18px 35px rgba(13,148,136,0.20)",
};