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

// "YYYY-MM-DD" for an arbitrary instant, as a calendar date in
// America/New_York — same NY-day convention as todayNYDateString above, but
// for grouping a batch of timestamps (e.g. a week of messages) into daily
// buckets rather than just labeling "today". Shared between server routes
// (admin per-account SMS/day breakdown) and client pages (the matching
// chart) so both sides bucket the exact same way.
export function nyDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(date);
}

function nyOffsetMinutes(date: Date): number {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const ny = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return (utc.getTime() - ny.getTime()) / 60000;
}

// "YYYY-MM-DD" for N calendar days before today, in America/New_York — pure
// calendar-day arithmetic on the already-NY-resolved "today" string, so it
// stays correct regardless of the visitor's own timezone or DST.
export function nyDateStringDaysAgo(daysAgo: number): string {
  const [y, m, d] = todayNYDateString().split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() - daysAgo);
  return dt.toISOString().slice(0, 10);
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

// "YYYY-MM" for the current calendar month in America/New_York — used to
// default a <input type="month"> and to cap it so a future month can't be
// selected.
export function currentNYMonthString(): string {
  return todayNYDateString().slice(0, 7);
}

// Given a "YYYY-MM" calendar month (interpreted in America/New_York), returns
// the UTC instants spanning that whole month (first day's NY midnight
// through the day after the last day's NY midnight) plus how many days it
// has - used to build one Firestore createdAt range query covering the
// entire month, and to know how many per-day tiles to render.
export function getNYMonthRangeUtc(monthStr: string): {
  start: Date;
  end: Date;
  daysInMonth: number;
} {
  const [y, m] = monthStr.split("-").map((part) => Number(part));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const start = getNYDayRangeUtc(`${monthStr}-01`).start;
  const end = getNYDayRangeUtc(`${monthStr}-${String(daysInMonth).padStart(2, "0")}`).end;
  return { start, end, daysInMonth };
}