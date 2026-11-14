// Every time the workspace shows is Pacific time on a 12-hour clock: `3:04 PM PST`, with the date in front when
// it is not today in Pacific time (`Nov 12, 3:04 PM PST`).

export const WORKSPACE_TIME_ZONE = "America/Los_Angeles";

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: WORKSPACE_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: WORKSPACE_TIME_ZONE, month: "short", day: "numeric" });
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: WORKSPACE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** `3:04 PM PST` for an instant, or `Nov 12, 3:04 PM PST` when it falls on another Pacific day than `now`. An
 * instant that does not parse comes back as written. */
export function formatPacificTime(instant: string | Date, now: Date = new Date()): string {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) return String(instant);
  // ICU may put a narrow no-break space before AM/PM; the workspace writes a plain space.
  const time = TIME.format(at).replace(/\u202f/g, " ");
  return DAY_KEY.format(at) === DAY_KEY.format(now) ? time : `${DAY.format(at)}, ${time}`;
}
