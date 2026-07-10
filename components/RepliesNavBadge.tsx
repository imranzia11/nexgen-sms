"use client";

import type { CSSProperties } from "react";
import { useRepliedCount } from "./useRepliedCount";
import { useManuallyBlockedAttention } from "./useManuallyBlockedAttention";

// Small red counter badge for the "Replies" nav card, showing how many
// conversations currently have an unanswered customer reply. Renders
// nothing when the count is zero. Place inside a `position: relative`
// container (or pass an already-relative Link/card as the parent).
//
// Also renders a separate yellow "needs attention" mark when the account
// has at least one manually-blocked conversation - entirely independent
// of the count above. It does not add to, subtract from, or otherwise
// touch the Customer Replied number; it's purely an extra signal that
// something needs a look.
export default function RepliesNavBadge() {
  const count = useRepliedCount();
  const needsAttention = useManuallyBlockedAttention();

  return (
    <>
      {count > 0 ? (
        <span style={badgeStyle}>{count > 99 ? "99+" : count}</span>
      ) : null}
      {needsAttention ? (
        <span style={attentionBadgeStyle} title="A blocked number needs attention">
          ⚠️
        </span>
      ) : null}
    </>
  );
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

// Positioned on the opposite corner from the red count badge so the two
// never overlap when both are showing at once.
const attentionBadgeStyle: CSSProperties = {
  position: "absolute",
  top: -7,
  left: -7,
  fontSize: 17,
  lineHeight: 1,
  zIndex: 2,
  filter: "drop-shadow(0 0 1px rgba(0,0,0,0.35))",
};
