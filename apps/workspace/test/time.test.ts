import { describe, expect, test } from "bun:test";
import { formatPacificTime, WORKSPACE_TIME_ZONE } from "../src/lib/time.ts";

describe("formatPacificTime", () => {
  test("shows Pacific time on a 12-hour clock with the zone", () => {
    // 22:04 UTC on Nov 13 2026 is 2:04 PM PST.
    expect(formatPacificTime("2026-11-13T22:04:00Z", new Date("2026-11-13T23:00:00Z"))).toBe("2:04 PM PST");
  });

  test("uses daylight time in summer", () => {
    expect(formatPacificTime("2026-07-01T16:30:00Z", new Date("2026-07-01T20:00:00Z"))).toBe("9:30 AM PDT");
  });

  test("puts the date in front on another Pacific day", () => {
    expect(formatPacificTime("2026-11-12T18:05:00Z", new Date("2026-11-13T18:00:00Z"))).toBe("Nov 12, 10:05 AM PST");
  });

  test("counts the day in Pacific time, not UTC", () => {
    // 07:30 UTC on Nov 14 is still 11:30 PM on Nov 13 in Pacific time.
    expect(formatPacificTime("2026-11-14T07:30:00Z", new Date("2026-11-13T20:00:00Z"))).toBe("11:30 PM PST");
  });

  test("writes midnight and noon as 12", () => {
    const now = new Date("2026-11-13T20:00:00Z");
    expect(formatPacificTime("2026-11-13T08:00:00Z", now)).toBe("12:00 AM PST");
    expect(formatPacificTime("2026-11-13T20:00:00Z", now)).toBe("12:00 PM PST");
  });

  test("never uses a narrow no-break space or a 24-hour hour", () => {
    const text = formatPacificTime(new Date("2026-11-13T23:59:00Z"), new Date("2026-11-13T23:59:00Z"));
    expect(text).toBe("3:59 PM PST");
    expect(text.includes("\u202f")).toBe(false);
  });

  test("returns an unparseable instant as written", () => {
    expect(formatPacificTime("not a time")).toBe("not a time");
  });

  test("names the zone it uses", () => {
    expect(WORKSPACE_TIME_ZONE).toBe("America/Los_Angeles");
  });
});
