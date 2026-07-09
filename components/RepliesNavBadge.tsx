"use client";

import type { CSSProperties } from "react";
import { useRepliedCount } from "./useRepliedCount";

// Small red counter badge for the "Replies" nav card, showing how many
// conversations currently have an unanswered customer reply. Renders
// nothing when the count is zero. Place inside a `position: relative`
// container (or pass an already-relative Link/card as the parent).
export default function RepliesNavBadge() {
  const count = useRepliedCount();

  if (count <= 0) return null;

  return <span style={badgeStyle}>{count > 99 ? "99+" : count}</span>;
}

const badgeStyle: CSSProperties = {
  position: "absolute",
  top: -6,
  right: -6,
  minWidth: 20,
  height: 20,
  padding: "0 5px",
  borderRadius: 999,
  background: "#ef4444",
  color: "#fff",
  fontSize: 11.5,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "0 0 0 2px rgba(0,0,0,0.25)",
  lineHeight: 1,
  zIndex: 2,
};
