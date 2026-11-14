/** Shared display formats for times, so every panel shows the same thing. Local time, 12-hour clock. */

type TimeInput = Date | string | number;

const clockTime = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
const dateTime = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function toDate(value: TimeInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2:53 AM`. Returns an empty string for a value that is not a time. */
export function formatClockTime(value: TimeInput): string {
  const date = toDate(value);
  return date ? clockTime.format(date) : "";
}

/** `Nov 12, 2026, 2:53 AM`. Returns an empty string for a value that is not a time. */
export function formatDateTime(value: TimeInput): string {
  const date = toDate(value);
  return date ? dateTime.format(date) : "";
}
