// Proposals of the `submission` check: the agent proposals each format's scenarios review. Ported from
// the prototype review demo's proposals module (the one its page, its browser check and its
// submission check shared), with the base files and recorded sessions taken from `fixtures/`.
//
// A proposal names its base fixture and its batches. A `session` proposal takes recorded batches
// verbatim, in order, from `<fmt>/sessions/session-20.json` (`picks`; later batches can address
// content earlier ones created, so the picks start at batch 0 and keep that order). The xlsx-only
// proposals are written here (op shapes of the engine's xlsx op reference). Each one was applied in
// order on its base file by the module this check runs against.
//
// Batches carry no clock: a pinned run applies them at the kernel's pinned clock; a live run gives
// each its own (`proposedAt` in `submission.ts`). Only `dated` writes the clock into the file (a
// TODAY() cache), so only its bytes depend on those times.
import type { Op } from "@wolfsdk/protocol";
import { BASE, FORMATS, sessionBatches, type Format } from "./harness.ts";

export type Batch = { label: string; ops: Op[] };

/** `session`: batches picked from the recorded session. `dependent`: a later batch addresses a cell by
 * the row an earlier one inserted. `repeated`: one batch holds the same op twice. `dated`: a TODAY() cache. */
export type ProposalKind = "session" | "dependent" | "repeated" | "dated";

export type Proposal = {
  id: string;
  title: string;
  format: Format;
  kind: ProposalKind;
  /** Base file, relative to `fixtures/`. The verifier uses its own copy of this file, never the submission's. */
  base: string;
  batches: Batch[];
};

/** Multi-op batch per format as an entry revision (1-based) of the session proposals: the batch whose ops the
 * "reject one op of a batch" scenario rejects one of (the prototype demo's README named these three). */
export const MULTI_OP_REVISION: Record<Format, number> = { docx: 5, pptx: 5, xlsx: 4 };

type Pick = { index: number; label: string };

const PICKS: Record<Format, Pick[]> = {
  docx: [
    { index: 0, label: "Rename the company to Harbor Ridge Logistics Ltd" },
    { index: 1, label: 'Replace "reliably" with "dependably"' },
    { index: 2, label: "Restyle a paragraph in bold dark blue Arial" },
    { index: 5, label: "Add a paragraph about regional volumes" },
    { index: 6, label: 'Italicize "regional volumes" and add a "More detail" link' },
  ],
  pptx: [
    { index: 0, label: 'Retitle the deck "Operating Review Pack FY26"' },
    { index: 1, label: "Rewrite the subtitle as two lines" },
    { index: 2, label: 'Change "Revenue" to "Net revenue" in a slide title' },
    { index: 3, label: "Set a table cell to 12.5" },
    { index: 4, label: "Set two table cells to 11.0 and +1.5" },
  ],
  xlsx: [
    { index: 0, label: "Set North America Q3 revenue to 10,000" },
    { index: 1, label: "Set Europe Q2 revenue to 5,600" },
    { index: 2, label: 'Add a "Delta" column heading' },
    { index: 3, label: "Add Q3 minus Q2 formulas for the four regions" },
    { index: 4, label: "Total the Delta column" },
  ],
};

const TITLES: Record<Format, string> = { docx: "Contract (DOCX)", pptx: "Deck (PPTX)", xlsx: "Model (XLSX)" };

const XLSX_BASE = `xlsx/${BASE.xlsx}`;

/** The proposals of `format`: its session proposal, and for xlsx the dependent, repeated and dated ones. */
export function proposalsFor(format: Format): Proposal[] {
  const recorded = sessionBatches(format);
  const base = `${format}/${BASE[format]}`;
  const session: Proposal = {
    id: format,
    title: TITLES[format],
    format,
    kind: "session",
    base,
    batches: PICKS[format].map(({ index, label }) => {
      const ops = recorded[index];
      if (!ops) throw new Error(`${format}/sessions/session-20.json has no batch ${index}`);
      return { label, ops };
    }),
  };
  if (format !== "xlsx") return [session];
  return [
    session,
    {
      // Batch 2 addresses C6 by its A1 address, which is Europe's Q3 cell only after batch 1 inserted a
      // row above Europe (row 5). Rejecting only batch 1 would move the edit onto APAC, so the review
      // store refuses it as coupled.
      id: "xlsx-dependent",
      title: "Model with a dependent change",
      format,
      kind: "dependent",
      base: XLSX_BASE,
      batches: [
        {
          label: "Insert a blank row above Europe",
          ops: [{ op: "insert", anchor: "sheet:Regions/row:@5", position: "before", node: { kind: "row" } }],
        },
        {
          label: "Set Europe Q3 revenue to 6,200 (cell C6 after the new row)",
          ops: [{ op: "set", target: "sheet:Regions/cell:C6", value: { number: 6200 } }],
        },
      ],
    },
    {
      // Batch 1 holds the same operation twice. Rejecting one copy leaves a batch that still holds that
      // operation, so only the op's position (`rejected_ops[].index`) against the verifier's own copy of
      // the proposal shows which copy was rejected.
      id: "xlsx-repeated",
      title: "Model with a repeated edit",
      format,
      kind: "repeated",
      base: XLSX_BASE,
      batches: [
        {
          label: "Set North America Q3 revenue to 7,777 twice, then Europe Q2 revenue to 5,600",
          ops: [
            { op: "set", target: "sheet:Regions/cell:C4", value: { number: 7777 } },
            { op: "set", target: "sheet:Regions/cell:C4", value: { number: 7777 } },
            { op: "set", target: "sheet:Regions/cell:B5", value: { number: 5600 } },
          ],
        },
      ],
    },
    {
      // TODAY() caches the date of the clock its batch ran at (in the batch's zone), so the file differs
      // per clock and the verifier's replay reproduces it only with each batch's own clock.
      id: "xlsx-dated",
      title: "Model with a dated note",
      format,
      kind: "dated",
      base: XLSX_BASE,
      batches: [
        {
          label: 'Add an "As of" note with today\'s date (E1 and F1)',
          ops: [
            { op: "set", target: "sheet:Regions/cell:E1", value: { text: "As of" } },
            { op: "set", target: "sheet:Regions/cell:F1", value: { formula: "=TODAY()" } },
          ],
        },
        {
          label: "Set North America Q3 revenue to 10,000",
          ops: [{ op: "set", target: "sheet:Regions/cell:C4", value: { number: 10000 } }],
        },
      ],
    },
  ];
}

/** Every proposal the verifier knows by id (the demo server's proposal list), across all formats. */
export const allProposals = (): Proposal[] => FORMATS.flatMap(proposalsFor);
