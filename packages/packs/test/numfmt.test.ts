// Number formats: the text a bound value becomes is a function of its value, its format code and the locale alone.
import { describe, expect, test } from "bun:test";
import { formatValue } from "../src/numfmt.ts";
import { codeOf } from "./fixtures.ts";

const fmt = (value: number | string | boolean | null, code: string | null, locale?: string, date1904 = false): string => formatValue(value, code, { locale, date1904 });

describe("numbers", () => {
  test("plain values have no format", () => {
    expect(fmt(1234.5, null)).toBe("1234.5");
    expect(fmt(0.1 + 0.2, null)).toBe("0.3");
    expect(fmt(1e21, null)).toBe("1E+21");
    expect(fmt(true, null)).toBe("TRUE");
    expect(fmt("text", null)).toBe("text");
    expect(fmt(null, "0.00")).toBe("");
    expect(fmt(5, "General")).toBe("5");
  });

  test("digit placeholders, grouping and rounding half away from zero", () => {
    expect(fmt(1234567.891, "#,##0.00")).toBe("1,234,567.89");
    expect(fmt(0.5, "0")).toBe("1");
    expect(fmt(2.5, "0")).toBe("3");
    expect(fmt(-2.5, "0")).toBe("-3");
    expect(fmt(1.005, "0.00")).toBe("1.01");
    expect(fmt(7, "000")).toBe("007");
    expect(fmt(0.25, "#.##")).toBe(".25");
    expect(fmt(1234567, "#,##0,")).toBe("1,235");
  });

  test("percent, currency and quoted literals", () => {
    expect(fmt(0.1234, "0.0%")).toBe("12.3%");
    expect(fmt(1234567.891, '"$"#,##0.00')).toBe("$1,234,567.89");
    expect(fmt(12, '0" units"')).toBe("12 units");
    expect(fmt(12, "0\\x")).toBe("12x");
  });

  test("sections choose by sign and zero", () => {
    const code = '#,##0;(#,##0);"nil"';
    expect(fmt(1500, code)).toBe("1,500");
    expect(fmt(-1500, code)).toBe("(1,500)");
    expect(fmt(0, code)).toBe("nil");
    expect(fmt("words", '0;0;0;@"!"')).toBe("words!");
  });

  test("the locale of the source sets the separators, never the host", async () => {
    expect(fmt(1234567.891, "#,##0.00", "de-DE")).toBe("1.234.567,89");
    expect(fmt(1234567.891, "#,##0.00", "fr-FR")).toBe("1\u202f234\u202f567,89");
    expect(fmt(1234567.891, "#,##0.00", "de-CH")).toBe("1\u2019234\u2019567.89");
    expect(fmt(1234567.891, "#,##0.00")).toBe("1,234,567.89");
    expect(await codeOf(() => fmt(1, "0", "xx-YY"))).toBe("unsupported-locale");
  });
});

describe("dates", () => {
  test("serial numbers become dates in the 1900 and 1904 systems", () => {
    expect(fmt(45292, "yyyy-mm-dd")).toBe("2024-01-01");
    expect(fmt(43831, "yyyy-mm-dd", undefined, true)).toBe("2024-01-02");
    expect(fmt(45292.75, "yyyy-mm-dd hh:mm")).toBe("2024-01-01 18:00");
    expect(fmt(45292.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(fmt(45292, "d mmm yyyy")).toBe("1 Jan 2024");
    expect(fmt(45292, "dddd, mmmm d")).toBe("Monday, January 1");
  });

  test("the 1900 leap day that never was is kept as the spreadsheet keeps it", () => {
    expect(fmt(59, "yyyy-mm-dd")).toBe("1900-02-28");
    expect(fmt(61, "yyyy-mm-dd")).toBe("1900-03-01");
  });
});

describe("what is not supported is refused, never approximated", () => {
  test.each([["[>100]0;0"], ["# ?/?"], ["0.00E+00"], ["[h]:mm"]])("%s", async (code) => {
    expect(await codeOf(() => fmt(5, code))).toBe("unsupported-number-format");
  });
});
