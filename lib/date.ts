export function formatFirestoreDateNY(value: any) {
  try {
    if (!value) return "-";

    const date =
      typeof value?.toDate === "function" ? value.toDate() : new Date(value);

    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return "-";
  }
}

export function formatDateOnlyNY(value: any) {
  try {
    if (!value) return "-";

    const date =
      typeof value?.toDate === "function" ? value.toDate() : new Date(value);

    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return "-";
  }
}

// "YYYY-MM-DD" for today, as a calendar date in America/New_York — used to
// default a date picker to "today" the same way the rest of the app already
// displays timestamps (NY time), regardless of the visitor's own timezone.
export function todayNYDateString(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
}

function nyOffsetMinutes(date: Date): number {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const ny = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return (utc.getTime() - ny.getTime()) / 60000;
}

// Given a "YYYY-MM-DD" calendar date (interpreted as a day in America/New_York),
// returns the UTC instants for that day's midnight-to-midnight NY window —
// used to build a Firestore createdAt range query for "show me this one day".
export function getNYDayRangeUtc(dateStr: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split("-").map((part) => Number(part));
  const naiveUtcMidnight = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0));
  const offsetMin = nyOffsetMinutes(naiveUtcMidnight);
  const start = new Date(naiveUtcMidnight.getTime() + offsetMin * 60000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}