// The pack manifest (`wolfsdk.pack.v1`, `pack.wolf.json`): the cross-format bindings that link values of
// spreadsheet sources to targets in Word and PowerPoint documents. The schema checks the shape; the function
// below adds what a schema can not say (ids resolve and are unique, a target kind fits its format, selector and
// fit policy, an address is a real cell). Nothing here touches the DOM, Preact or a kernel.
import { validateSchema, type Schema } from "../session/record.ts";
import packSchema from "../../schemas/pack.v1.schema.json" with { type: "json" };
import { isWorkspaceInstant } from "./room.ts";

export const PACK_CONTRACT = "wolfsdk.pack.v1";
export const PACK_SCHEMA: Schema = packSchema;
/** The file name of a manifest inside a pack. */
export const PACK_MANIFEST_FILE = "pack.wolf.json";

export const PACK_SOURCE_KINDS = ["xlsx", "csv_snapshot", "sql_snapshot"] as const;
export type PackSourceKind = (typeof PACK_SOURCE_KINDS)[number];

export const PACK_TARGET_KINDS = ["docx_table", "docx_bookmark", "pptx_table", "pptx_chart_series", "pptx_fit_headline"] as const;
export type PackTargetKind = (typeof PACK_TARGET_KINDS)[number];

export const PACK_FIT_POLICIES = ["none", "grow", "shrink_to_fit", "truncate", "fail"] as const;
export type PackFitPolicy = (typeof PACK_FIT_POLICIES)[number];

/** The fit policies each target kind can honour: a table grows, a headline shrinks, a bookmark and a chart
 * series have neither rows nor a font to change. */
export const PACK_FIT_POLICIES_BY_TARGET: Readonly<Record<PackTargetKind, readonly PackFitPolicy[]>> = {
  docx_table: ["none", "grow", "truncate", "fail"],
  pptx_table: ["none", "grow", "truncate", "fail"],
  docx_bookmark: ["none", "truncate", "fail"],
  pptx_chart_series: ["none", "fail"],
  pptx_fit_headline: ["none", "shrink_to_fit", "truncate", "fail"],
};

export type PackDeterminism = { clock: string; seed: number; timezone?: string; locale?: string; snapshot_sha256?: string };

export type PackSource = { id: string; kind: PackSourceKind; doc_name: string; determinism: PackDeterminism };

export type PackSelector =
  | { type: "cell"; sheet: string; ref: string }
  | { type: "range"; sheet: string; ref: string }
  | { type: "table"; name: string }
  | { type: "defined_name"; name: string };

export type PackTargetFormat = "docx" | "pptx";

export type PackBinding = {
  id: string;
  source_id: string;
  selector: PackSelector;
  target_doc: string;
  target_format: PackTargetFormat;
  target_kind: PackTargetKind;
  target_address: string;
  number_format: string | null;
  fit_policy: PackFitPolicy;
};

export type PackManifest = {
  contract: typeof PACK_CONTRACT;
  pack_id: string;
  name: string;
  sources: PackSource[];
  bindings: PackBinding[];
};

const MAX_COLUMN = 16_384;
const MAX_ROW = 1_048_576;

/** Column and row of an A1 reference (`$` anchors allowed), or undefined outside the sheet grid (XFD, 1048576). */
function parseCell(ref: string): { column: number; row: number } | undefined {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return undefined;
  let column = 0;
  for (const ch of m[1] ?? "") column = column * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  return column <= MAX_COLUMN && row >= 1 && row <= MAX_ROW ? { column, row } : undefined;
}

function selectorProblems(path: string, selector: PackSelector, out: string[]): void {
  if (selector.type === "cell" && !parseCell(selector.ref)) out.push(`${path}.ref: ${JSON.stringify(selector.ref)} is not a cell of the sheet grid`);
  if (selector.type !== "range") return;
  const [from, to] = selector.ref.split(":").map((r) => parseCell(r));
  if (!from || !to) out.push(`${path}.ref: ${JSON.stringify(selector.ref)} is not a range of the sheet grid`);
  else if (from.column > to.column || from.row > to.row) out.push(`${path}.ref: ${JSON.stringify(selector.ref)} runs backwards`);
}

/** A bookmark and a headline take one value; a table and a chart series take a block of them. */
const SINGLE_VALUE_TARGETS: readonly PackTargetKind[] = ["docx_bookmark", "pptx_fit_headline"];

/** Problems of a `pack.wolf.json` manifest (empty when valid): its shape, then the agreement of its sources and
 * bindings. A binding's `source_id` names a source of the pack; its `target_kind` belongs to its `target_format`
 * and its `target_doc` carries that extension; its `fit_policy` is one its target kind can honour
 * (`PACK_FIT_POLICIES_BY_TARGET`); its selector shape fits the target (one cell for a bookmark or headline, a
 * range, table or name for a table or chart series). Two bindings never write the same target. A CSV or SQL
 * snapshot names the sha256 it was taken from; an XLSX source, which is the document itself, does not. */
export function validatePackManifest(manifest: unknown): string[] {
  const out = validateSchema(PACK_SCHEMA, manifest);
  if (out.length) return out;
  const pack = manifest as PackManifest;

  const sources = new Set<string>();
  pack.sources.forEach((s, i) => {
    const at = `$.sources[${i}]`;
    if (sources.has(s.id)) out.push(`${at}.id: ${JSON.stringify(s.id)} is used twice`);
    sources.add(s.id);
    if (!isWorkspaceInstant(s.determinism.clock)) out.push(`${at}.determinism.clock: not a calendar instant`);
    const snapshot = s.determinism.snapshot_sha256 !== undefined;
    if (s.kind === "xlsx" && snapshot) out.push(`${at}.determinism.snapshot_sha256: an xlsx source is the document itself, it has no snapshot`);
    if (s.kind !== "xlsx" && !snapshot) out.push(`${at}.determinism.snapshot_sha256: a ${s.kind} names the sha256 of its snapshot`);
    if (s.kind === "xlsx" && !/\.xlsx$/i.test(s.doc_name)) out.push(`${at}.doc_name: an xlsx source is an .xlsx document`);
  });

  const bindings = new Set<string>();
  const targets = new Set<string>();
  pack.bindings.forEach((b, i) => {
    const at = `$.bindings[${i}]`;
    if (bindings.has(b.id)) out.push(`${at}.id: ${JSON.stringify(b.id)} is used twice`);
    bindings.add(b.id);
    if (!sources.has(b.source_id)) out.push(`${at}.source_id: ${JSON.stringify(b.source_id)} is not a source of the pack`);
    selectorProblems(`${at}.selector`, b.selector, out);

    if (!b.target_kind.startsWith(`${b.target_format}_`)) out.push(`${at}.target_kind: ${b.target_kind} is not a ${b.target_format} target`);
    if (!b.target_doc.toLowerCase().endsWith(`.${b.target_format}`)) out.push(`${at}.target_doc: a ${b.target_format} target is a .${b.target_format} document`);
    if (!PACK_FIT_POLICIES_BY_TARGET[b.target_kind].includes(b.fit_policy))
      out.push(`${at}.fit_policy: ${b.fit_policy} does not apply to ${b.target_kind} (one of ${PACK_FIT_POLICIES_BY_TARGET[b.target_kind].join(", ")})`);

    const single = SINGLE_VALUE_TARGETS.includes(b.target_kind);
    if (single && (b.selector.type === "range" || b.selector.type === "table"))
      out.push(`${at}.selector: ${b.target_kind} takes one value, not a ${b.selector.type}`);
    if (!single && b.selector.type === "cell") out.push(`${at}.selector: ${b.target_kind} takes a block of values, not one cell`);

    const target = JSON.stringify([b.target_doc, b.target_kind, b.target_address]);
    if (targets.has(target)) out.push(`${at}.target_address: ${JSON.stringify(b.target_address)} of ${b.target_doc} is bound twice`);
    targets.add(target);
  });
  return out;
}
