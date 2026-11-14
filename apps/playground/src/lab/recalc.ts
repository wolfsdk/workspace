/**
 * The Recalc report, read from the engine's damage report. For a workbook,
 * Wolf's row of `damage-report.json` carries `formula_results`: `different`
 * lists each formula cell whose saved cached value (`actual`) differs from
 * Wolf's own recalculation (`expected`). Nothing here recalculates; every
 * value comes from the report.
 */
import type { RecalcReport, RecalcResult, TypedValue } from "./types.ts";

/** Output the `damage_report` call writes, under its default stem. */
export const DAMAGE_REPORT_JSON = "/mem/out/damage-report.json";

type Scalar = number | string | boolean | null;

type FormulaResults = {
  status: "checked" | "not-applicable" | "not-run";
  reason: string | null;
  different: { cell: string; expected: Scalar; actual: Scalar }[] | null;
};

/** `Sheet!A1` or `'My Sheet'!A1` into its sheet name and cell. */
export function splitLocator(locator: string): { sheet: string; a1: string } {
  const bang = locator.lastIndexOf("!");
  if (bang < 0) throw new Error(`damage report cell "${locator}" has no sheet`);
  const raw = locator.slice(0, bang);
  const quoted = raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'");
  const sheet = quoted ? raw.slice(1, -1).replaceAll("''", "'") : raw;
  return { sheet, a1: locator.slice(bang + 1).replaceAll("$", "").toUpperCase() };
}

function typed(value: Scalar): TypedValue | null {
  if (value === null) return null;
  if (typeof value === "number") return { number: value };
  if (typeof value === "boolean") return { boolean: value };
  return { string: value };
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** Wolf's `formula_results` for the one file of the report. The shape is
 * fixed by the damage-report schema; only the members read here are checked. */
function formulaResultsOf(json: unknown): FormulaResults {
  const files = field(json, "files");
  const results = Array.isArray(files) ? field(field(files[0], "wolf"), "formula_results") : undefined;
  const status = field(results, "status");
  if (status !== "checked" && status !== "not-applicable" && status !== "not-run") {
    throw new Error("the damage report has no formula results for this workbook");
  }
  const reason = field(results, "reason");
  const different = field(results, "different");
  return {
    status,
    reason: typeof reason === "string" ? reason : null,
    different: Array.isArray(different) ? (different as FormulaResults["different"]) : null,
  };
}

/**
 * The Recalc result from the bytes of `damage-report.json`. `ms` is the time
 * the call took in this tab. `formulas` stays `null`: the report lists the
 * cells that differ, not how many it compared.
 */
export function recalcFromDamageReport(json: Uint8Array, ms: number): RecalcResult {
  const results = formulaResultsOf(JSON.parse(new TextDecoder().decode(json)));
  if (results.status === "not-run") return { kind: "unavailable", reason: results.reason ?? "not run" };
  if (results.status === "not-applicable") return { kind: "unavailable", reason: "the workbook has no formulas to check" };
  const cells: RecalcReport["cells"] = (results.different ?? []).map((d) => {
    const { sheet, a1 } = splitLocator(d.cell);
    return {
      address: `sheet:${sheet}/cell:${a1}`,
      sheet,
      a1,
      cached: typed(d.actual),
      computed: typed(d.expected) ?? { empty: true },
    };
  });
  return { kind: "report", report: { formulas: null, ms, cells } };
}
