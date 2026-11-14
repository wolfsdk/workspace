// Excel number format codes, deterministic. A bound value is formatted from its number format code and the
// source's locale alone: no host locale, no `Intl`, no clock. Supported: the digit placeholders `0 # ?`, the
// thousands separator and trailing-comma scaling, the decimal point, `%`, quoted and escaped literals, currency
// symbols, up to four sections (positive; negative; zero; text), colour tags (ignored) and the date and time
// codes `y m d h s AM/PM` (English names). A code outside that set (conditions, fractions, scientific, elapsed
// time) is refused with `unsupported-number-format`, never approximated.
import { PackError } from "./errors.ts";

export type CellValue = string | number | boolean | null;
/** A value of a source with the number format code its own cell has (`null` when it has none beyond General). */
export type SourceCell = { value: CellValue; format: string | null };

type Separators = { group: string; decimal: string };

const COMMA_DOT: Separators = { group: ",", decimal: "." };
const DOT_COMMA: Separators = { group: ".", decimal: "," };
const SPACE_COMMA: Separators = { group: "\u00a0", decimal: "," };

const LANGUAGE_SEPARATORS: Readonly<Record<string, Separators>> = {
  en: COMMA_DOT,
  ja: COMMA_DOT,
  zh: COMMA_DOT,
  ko: COMMA_DOT,
  he: COMMA_DOT,
  th: COMMA_DOT,
  de: DOT_COMMA,
  es: DOT_COMMA,
  it: DOT_COMMA,
  pt: DOT_COMMA,
  nl: DOT_COMMA,
  tr: DOT_COMMA,
  id: DOT_COMMA,
  da: DOT_COMMA,
  el: DOT_COMMA,
  fr: { group: "\u202f", decimal: "," },
  ru: SPACE_COMMA,
  uk: SPACE_COMMA,
  pl: SPACE_COMMA,
  cs: SPACE_COMMA,
  sv: SPACE_COMMA,
  nb: SPACE_COMMA,
  fi: SPACE_COMMA,
};

export function separatorsOf(locale: string | undefined): Separators {
  const tag = (locale ?? "en-US").replace("_", "-");
  if (/^de-(CH|LI)$/i.test(tag)) return { group: "\u2019", decimal: "." };
  if (/^es-(MX|US)$/i.test(tag)) return COMMA_DOT;
  const found = LANGUAGE_SEPARATORS[(tag.split("-")[0] ?? "").toLowerCase()];
  if (found === undefined) throw new PackError("unsupported-locale", `the locale ${JSON.stringify(locale)} has no separator table in this version`);
  return found;
}

const unsupported = (code: string, why: string): PackError => new PackError("unsupported-number-format", `number format ${JSON.stringify(code)}: ${why}`);

/** Built-in number format ids of a workbook and the codes they stand for. */
export const BUILTIN_NUMBER_FORMATS: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
};

/** General: the shortest text that reads back as the same number to 15 significant digits. */
export function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(15))).replace("e+", "E+").replace("e-", "E-");
}

export function plainValue(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return typeof value === "number" ? plainNumber(value) : value;
}

// Sections -------------------------------------------------------------------------------------------------

type Token =
  | { kind: "literal"; text: string }
  | { kind: "digit"; ch: "0" | "#" | "?" }
  | { kind: "point" }
  | { kind: "comma" }
  | { kind: "percent" }
  | { kind: "text" }
  | { kind: "date"; letters: string }
  | { kind: "ampm"; text: string };

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = "";
  let quote = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] ?? "";
    if (ch === "\\" && !quote) {
      current += ch + (code[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "[") bracket = true;
    else if (!quote && ch === "]") bracket = false;
    if (ch === ";" && !quote && !bracket) {
      sections.push(current);
      current = "";
    } else current += ch;
  }
  sections.push(current);
  return sections;
}

const COLOUR_TAG = /^\[(black|blue|cyan|green|magenta|red|white|yellow|color ?\d+)\]$/i;

function tokenize(code: string, section: string): Token[] {
  const tokens: Token[] = [];
  const pushLiteral = (text: string): void => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === "literal") last.text += text;
    else tokens.push({ kind: "literal", text });
  };
  for (let i = 0; i < section.length; i++) {
    const ch = section[i] ?? "";
    if (ch === '"') {
      const close = section.indexOf('"', i + 1);
      if (close < 0) throw unsupported(code, "a quoted literal is not closed");
      pushLiteral(section.slice(i + 1, close));
      i = close;
    } else if (ch === "\\") {
      pushLiteral(section[i + 1] ?? "");
      i++;
    } else if (ch === "_") {
      pushLiteral(" ");
      i++;
    } else if (ch === "*") {
      i++;
    } else if (ch === "[") {
      const close = section.indexOf("]", i);
      if (close < 0) throw unsupported(code, "a bracket is not closed");
      const tag = section.slice(i, close + 1);
      const currency = /^\[\$([^-\]]*)(?:-[0-9A-Fa-f]+)?\]$/.exec(tag);
      if (COLOUR_TAG.test(tag)) {
        // Colour is presentation, not text.
      } else if (currency) pushLiteral(currency[1] ?? "");
      else throw unsupported(code, `${tag} (a condition or elapsed time) is not supported`);
      i = close;
    } else if (ch === "0" || ch === "#" || ch === "?") tokens.push({ kind: "digit", ch });
    else if (ch === ".") tokens.push({ kind: "point" });
    else if (ch === ",") tokens.push({ kind: "comma" });
    else if (ch === "%") tokens.push({ kind: "percent" });
    else if (ch === "@") tokens.push({ kind: "text" });
    else if (/[AaPp]/.test(ch) && /^(am\/pm|a\/p)/i.test(section.slice(i))) {
      const m = /^(am\/pm|a\/p)/i.exec(section.slice(i)) as RegExpExecArray;
      tokens.push({ kind: "ampm", text: m[1] ?? "" });
      i += (m[1] ?? "").length - 1;
    } else if (/[ymdhsYMDHS]/.test(ch)) {
      let j = i;
      while (j < section.length && (section[j] ?? "").toLowerCase() === ch.toLowerCase()) j++;
      tokens.push({ kind: "date", letters: section.slice(i, j).toLowerCase() });
      i = j - 1;
    } else if (/[Ee]/.test(ch) && /^[Ee][+-]/.test(section.slice(i))) throw unsupported(code, "scientific notation is not supported");
    else if (ch === "/") throw unsupported(code, "fractions are not supported");
    else pushLiteral(ch);
  }
  return tokens;
}

// Rounding -------------------------------------------------------------------------------------------------

/** `abs` rounded half away from zero to `decimals` places, on its 15-significant-digit decimal form (what Excel does). */
function roundToDigits(abs: number, decimals: number): { integer: string; fraction: string } {
  const [mantissa = "0", exponentText = "0"] = abs.toExponential(14).split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  // digits[0] is the units digit of mantissa; the decimal point of the number sits after `exponent + 1` digits.
  const pointAt = exponent + 1;
  let all = digits;
  let at = pointAt;
  if (at <= 0) {
    all = "0".repeat(1 - at) + all;
    at = 1;
  } else if (at > all.length) all += "0".repeat(at - all.length);
  const keep = at + decimals;
  let kept = all.slice(0, keep).padEnd(keep, "0");
  const next = all[keep] ?? "0";
  if (next >= "5") {
    kept = (BigInt(kept) + 1n).toString().padStart(kept.length, "0");
  }
  const integer = kept.slice(0, kept.length - decimals).replace(/^0+(?=\d)/, "") || "0";
  const fraction = decimals === 0 ? "" : kept.slice(kept.length - decimals);
  return { integer, fraction };
}

// Numbers --------------------------------------------------------------------------------------------------

function formatNumberSection(code: string, tokens: Token[], value: number, signed: boolean, separators: Separators): string {
  const first = tokens.findIndex((t) => t.kind === "digit" || t.kind === "point");
  let last = -1;
  tokens.forEach((t, i) => {
    if (t.kind === "digit" || t.kind === "point") last = i;
  });
  if (first < 0) {
    // No placeholder: the literal text only (a section such as `"zero"`).
    return (signed && value < 0 ? "-" : "") + tokens.map((t) => (t.kind === "literal" ? t.text : t.kind === "percent" ? "%" : "")).join("");
  }
  let percents = 0;
  let prefix = "";
  let suffix = "";
  tokens.forEach((t, i) => {
    const text = t.kind === "literal" ? t.text : t.kind === "percent" ? "%" : "";
    if (t.kind === "percent") percents++;
    if (i < first) prefix += text;
    else if (i > last) suffix += text;
  });
  // Between the first and last placeholder only placeholders, `.` and `,` may stand.
  let pointSeen = false;
  let thousands = false;
  let scale = 0;
  let integerZeros = 0;
  let integerSlots = 0;
  let fractionMin = 0;
  let fractionMax = 0;
  for (let i = first; i <= last; i++) {
    const t = tokens[i] as Token;
    if (t.kind === "digit") {
      if (pointSeen) {
        fractionMax++;
        if (t.ch === "0") fractionMin = fractionMax;
      } else {
        integerSlots++;
        if (t.ch === "0") integerZeros++;
      }
    } else if (t.kind === "point") {
      if (pointSeen) throw unsupported(code, "two decimal points");
      pointSeen = true;
    } else if (t.kind === "comma") {
      const next = tokens[i + 1];
      if (!pointSeen && next?.kind === "digit") thousands = true;
      else if (!pointSeen) scale++;
      else throw unsupported(code, "a thousands separator after the decimal point");
    } else throw unsupported(code, "a literal between digit placeholders");
  }
  // Trailing commas right after the last integer placeholder (before `.` or the end) scale by 1000 each.
  for (let i = last + 1; i < tokens.length && (tokens[i] as Token).kind === "comma"; i++) scale++;
  if (percents > 0) value *= 100 ** percents;
  value /= 1000 ** scale;
  const negative = value < 0;
  const { integer, fraction } = roundToDigits(Math.abs(value), fractionMax);
  let fractionText = fraction;
  while (fractionText.length > fractionMin && fractionText.endsWith("0")) fractionText = fractionText.slice(0, -1);
  let integerText = integer;
  if (integerZeros === 0 && integerText === "0") integerText = "";
  if (integerText.length < integerZeros) integerText = integerText.padStart(integerZeros, "0");
  const questionSlots = tokens.slice(first, last + 1).filter((t) => t.kind === "digit" && t.ch === "?").length;
  if (questionSlots > 0 && integerText.length < integerSlots) integerText = integerText.padStart(integerSlots, " ");
  if (thousands) integerText = integerText.replace(/\B(?=(\d{3})+(?!\d))/g, "\u0000").replace(/\u0000/g, separators.group);
  const point = pointSeen ? separators.decimal : "";
  const shown = (signed && negative ? "-" : "") + prefix + integerText + point + fractionText + suffix;
  return shown;
}

// Dates ----------------------------------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Moment = { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };

/** The calendar date and time of an Excel serial number. */
export function serialToMoment(serial: number, date1904: boolean, code: string): Moment {
  if (!(serial >= 0) || serial >= 2958466) throw new PackError("date-out-of-range", `${plainNumber(serial)} is not a date serial number Excel can show (format ${JSON.stringify(code)})`);
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86400);
  if (seconds >= 86400) {
    seconds -= 86400;
    days += 1;
  }
  let year: number;
  let month: number;
  let day: number;
  let weekday: number;
  if (!date1904 && days === 60) {
    // Excel's 1900 leap year bug: serial 60 is "1900-02-29".
    [year, month, day, weekday] = [1900, 2, 29, 3];
  } else if (!date1904 && days === 0) {
    [year, month, day, weekday] = [1900, 1, 0, 6];
  } else {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const date = new Date(epoch + days * 86400000);
    [year, month, day, weekday] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()];
  }
  return { year, month, day, weekday, hour: Math.floor(seconds / 3600), minute: Math.floor((seconds % 3600) / 60), second: seconds % 60 };
}

function formatDateSection(code: string, tokens: Token[], value: number, date1904: boolean, locale: string | undefined): string {
  const names = (locale ?? "en-US").toLowerCase().startsWith("en");
  const m = serialToMoment(value, date1904, code);
  const twelve = tokens.some((t) => t.kind === "ampm");
  const two = (n: number): string => String(n).padStart(2, "0");
  let out = "";
  tokens.forEach((t, i) => {
    if (t.kind === "literal") out += t.text;
    else if (t.kind === "ampm") {
      const pm = m.hour >= 12;
      out += t.text.toLowerCase() === "a/p" ? (pm ? "P" : "A") : pm ? "PM" : "AM";
    } else if (t.kind === "date") {
      const l = t.letters;
      const c = l[0];
      if (c === "y") {
        if (l.length > 4) throw unsupported(code, "more than four year digits");
        out += l.length <= 2 ? two(m.year % 100) : String(m.year).padStart(4, "0");
      } else if (c === "d") {
        if (l.length <= 2) out += l.length === 2 ? two(m.day) : String(m.day);
        else {
          if (!names) throw unsupported(code, `day names are not available for the locale ${JSON.stringify(locale)}`);
          const name = WEEKDAYS[m.weekday] ?? "";
          out += l.length === 3 ? name.slice(0, 3) : name;
        }
      } else if (c === "h") out += l.length === 2 ? two(twelve ? m.hour % 12 || 12 : m.hour) : String(twelve ? m.hour % 12 || 12 : m.hour);
      else if (c === "s") out += l.length === 2 ? two(m.second) : String(m.second);
      else if (c === "m") {
        // `m` after an hour code, or before a second code, is a minute; otherwise a month.
        const before = tokens.slice(0, i).reverse().find((x) => x.kind === "date");
        const after = tokens.slice(i + 1).find((x) => x.kind === "date");
        const minute = (before?.kind === "date" && before.letters[0] === "h") || (after?.kind === "date" && after.letters[0] === "s");
        if (minute) out += l.length === 2 ? two(m.minute) : String(m.minute);
        else if (l.length <= 2) out += l.length === 2 ? two(m.month) : String(m.month);
        else {
          if (!names) throw unsupported(code, `month names are not available for the locale ${JSON.stringify(locale)}`);
          const name = MONTHS[m.month - 1] ?? "";
          out += l.length === 3 ? name.slice(0, 3) : l.length === 4 ? name : name.slice(0, 1);
        }
      }
    } else if (t.kind === "point") out += ".";
    else if (t.kind === "comma") out += ",";
    else if (t.kind === "percent") out += "%";
    else if (t.kind === "digit") throw unsupported(code, "digit placeholders mixed with date codes");
  });
  return out;
}

// Entry point ----------------------------------------------------------------------------------------------

export type FormatContext = { locale?: string; date1904?: boolean };

/**
 * `value` as text under the number format `code`. A `null` code is the plain form of the value. An empty value
 * is empty text under every code.
 */
export function formatValue(value: CellValue, code: string | null, context: FormatContext = {}): string {
  if (value === null) return "";
  if (code === null) return plainValue(value);
  const sections = splitSections(code);
  if (sections.length > 4) throw unsupported(code, "more than four sections");
  const bodies = sections.map((s) => s.trim());
  if (bodies.every((s) => s === "")) throw unsupported(code, "the code is empty");
  if (typeof value === "boolean") return plainValue(value);
  if (typeof value === "string") {
    const textSection = sections.length === 4 ? (sections[3] as string) : sections.length === 1 && sections[0]?.includes("@") ? (sections[0] as string) : undefined;
    if (textSection === undefined) return value;
    return tokenize(code, textSection)
      .map((t) => (t.kind === "text" ? value : t.kind === "literal" ? t.text : ""))
      .join("");
  }
  if (!Number.isFinite(value)) return plainValue(value);
  if (bodies.length === 1 && bodies[0]?.toLowerCase() === "general") return plainNumber(value);
  let index = 0;
  let signed = true;
  if (sections.length >= 2) {
    if (value < 0) {
      index = 1;
      signed = false;
    } else if (value === 0 && sections.length >= 3) index = 2;
  }
  const body = sections[index] as string;
  const separators = separatorsOf(context.locale);
  const tokens = tokenize(code, body);
  if (tokens.some((t) => t.kind === "date" || t.kind === "ampm")) {
    return formatDateSection(code, tokens, signed ? value : Math.abs(value), context.date1904 === true, context.locale);
  }
  return formatNumberSection(code, tokens, signed ? value : Math.abs(value), signed, separators);
}
