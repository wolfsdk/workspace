// Part B of the `subset-replay` check: the seeded cases and controls, ported from the prototype review
// package's subset-check script. Data only; `subset-replay.ts` runs them.
//
// Engine finding (XLSX): ops in one batch resolve against the batch BASE grid, not in order,
// contradicting the prototype's XLSX op notes ("a later op sees the shifted grid of an earlier
// insert"). Probes: [insert row before sheet:Regions/row:@5, set cell:C6=6100] writes 6100 to the
// original C6 (APAC, now C7); [insert row before row:@9, set cell:C11=777] leaves the ledger value in
// C11 and puts 777 in C12. So the in-batch insert+set case is informational (any verdict; if ok it must
// match the reference). The overwrite case [set C4=1, set C4=2] reject op 1 must reset op 0's hunk to
// pending by records (9600->2 becomes 9600->1). The formula case [set B4=100, set E4 "=B4*2"] reject
// op 0 must reset the kept E4 hunk to pending by state: the engine reports E4 as `added` with no value
// both times, so the records are equal, but its view node holds 200 before and 17800 after. Controls
// must keep every kept hunk approved.
import type { Op } from "@wolfsdk/protocol";
import type { Format } from "./harness.ts";

/** What a case rejects: ops of one entry (`rejectOps`), or the whole entry (`rejectOnly`). */
export type Action = { kind: "ops"; entry: number; ops: number[] } | { kind: "only"; entry: number };
export type Expect = "independent" | "coupled-or-refused" | "any";

export type Seed = {
  fmt: Format;
  name: string;
  batches: Op[][];
  action: Action;
  expect: Expect;
  /** Decision expected for this kept hunk (new op index) after ok. */
  keptHunk?: { op: number; decision: "approve" | "pending" };
  control?: boolean;
};

const insertRow5: Op = { op: "insert", anchor: "sheet:Regions/row:@5", position: "before", node: { kind: "row" } };

export const SEEDS: Seed[] = [
  {
    fmt: "xlsx",
    name: "in-batch insert row before row 5, set C6 (base-resolved, informational)",
    batches: [[insertRow5, { op: "set", target: "sheet:Regions/cell:C6", value: { number: 6100 } }]],
    action: { kind: "ops", entry: 0, ops: [0] },
    expect: "any",
  },
  {
    fmt: "xlsx",
    name: "cross-entry insert row before row 5, then set C6",
    batches: [[insertRow5], [{ op: "set", target: "sheet:Regions/cell:C6", value: { number: 6100 } }]],
    action: { kind: "only", entry: 0 },
    expect: "coupled-or-refused",
  },
  {
    fmt: "xlsx",
    name: "cross-entry insert column before D, then set E12 (both cells empty)",
    batches: [
      [{ op: "insert", anchor: "sheet:Regions/col:D", position: "before", node: { kind: "col" } }],
      [{ op: "set", target: "sheet:Regions/cell:E12", value: { string: "Checked" } }],
    ],
    action: { kind: "only", entry: 0 },
    expect: "coupled-or-refused",
  },
  {
    fmt: "xlsx",
    name: "same-cell overwrite C4=1 then C4=2, reject op 1",
    batches: [
      [
        { op: "set", target: "sheet:Regions/cell:C4", value: { number: 1 } },
        { op: "set", target: "sheet:Regions/cell:C4", value: { number: 2 } },
      ],
    ],
    action: { kind: "ops", entry: 0, ops: [1] },
    expect: "independent",
    keptHunk: { op: 0, decision: "pending" },
  },
  {
    fmt: "xlsx",
    name: "formula dependence B4=100 then E4 =B4*2, reject op 0",
    batches: [
      [
        { op: "set", target: "sheet:Regions/cell:B4", value: { number: 100 } },
        { op: "set", target: "sheet:Regions/cell:E4", value: { formula: "=B4*2" } },
      ],
    ],
    action: { kind: "ops", entry: 0, ops: [0] },
    expect: "independent",
    keptHunk: { op: 0, decision: "pending" },
  },
  {
    fmt: "xlsx",
    name: "control: set Regions E3 and Summary A9, reject op 0",
    batches: [
      [
        { op: "set", target: "sheet:Regions/cell:E3", value: { string: "Delta" } },
        { op: "set", target: "sheet:#2/cell:A9", value: { string: "Reviewed" } },
      ],
    ],
    action: { kind: "ops", entry: 0, ops: [0] },
    expect: "independent",
    control: true,
  },
  // Time-stamping controls: NOW() caches the batch clock, comments and tracked changes carry their
  // batch's date. In the live pass each batch has its own clock, so these only pass when every replay
  // and the rejected ops run with the clock their original batch ran with.
  {
    fmt: "xlsx",
    name: "control: NOW() in E3 and set A9, then set E12, reject op 0 (time-stamped)",
    batches: [
      [
        { op: "set", target: "sheet:Regions/cell:E3", value: { formula: "=NOW()" } },
        { op: "set", target: "sheet:#2/cell:A9", value: { string: "Reviewed" } },
      ],
      [{ op: "set", target: "sheet:Regions/cell:E12", value: { string: "Checked" } }],
    ],
    action: { kind: "ops", entry: 0, ops: [0] },
    expect: "independent",
    control: true,
  },
  {
    fmt: "xlsx",
    name: "control: NOW() in E3, then set E12, reject-only the NOW() batch (time-stamped)",
    batches: [
      [{ op: "set", target: "sheet:Regions/cell:E3", value: { formula: "=NOW()" } }],
      [{ op: "set", target: "sheet:Regions/cell:E12", value: { string: "Checked" } }],
    ],
    action: { kind: "only", entry: 0 },
    expect: "independent",
    control: true,
  },
  {
    fmt: "xlsx",
    name: "control: NOW() in E3 and set A9, then set E12, reject op 1 (kept NOW() time-stamped)",
    batches: [
      [
        { op: "set", target: "sheet:Regions/cell:E3", value: { formula: "=NOW()" } },
        { op: "set", target: "sheet:#2/cell:A9", value: { string: "Reviewed" } },
      ],
      [{ op: "set", target: "sheet:Regions/cell:E12", value: { string: "Checked" } }],
    ],
    action: { kind: "ops", entry: 0, ops: [1] },
    expect: "independent",
    control: true,
  },
  {
    fmt: "docx",
    name: "cross-entry insert paragraph after para 25, then set para:@27",
    batches: [
      [
        {
          op: "insert",
          anchor: "para:~5b2c9903",
          position: "after",
          node: { kind: "paragraph", text: "Inserted note." },
        },
      ],
      [{ op: "set", target: "para:@27", value: { text: "Management reviewed each open risk (edited)." } }],
    ],
    action: { kind: "only", entry: 0 },
    expect: "coupled-or-refused",
  },
  {
    fmt: "docx",
    name: "cross-entry insert paragraph after para 25, then comment on para:@27 (time-stamped restore)",
    batches: [
      [
        {
          op: "insert",
          anchor: "para:~5b2c9903",
          position: "after",
          node: { kind: "paragraph", text: "Inserted note." },
        },
      ],
      [
        {
          op: "insert",
          anchor: "para:@27",
          position: "last-child",
          node: { kind: "comment", text: "Check this", author: "Ann", initials: "A" },
        },
      ],
    ],
    action: { kind: "only", entry: 0 },
    expect: "coupled-or-refused",
  },
  {
    fmt: "docx",
    name: "control: set title and date paragraphs, reject op 1",
    batches: [
      [
        { op: "set", target: "para:~5525e827", value: { text: "Harbor Ridge Logistics Group" } },
        { op: "set", target: "para:~5c74b0a5", value: { text: "Published 1 October 2026" } },
      ],
    ],
    action: { kind: "ops", entry: 0, ops: [1] },
    expect: "independent",
    control: true,
  },
  {
    fmt: "docx",
    name: "control: comment on the title and set the date paragraph, then set para:@27, reject the comment (time-stamped)",
    batches: [
      [
        {
          op: "insert",
          anchor: "para:~5525e827",
          position: "last-child",
          node: { kind: "comment", text: "Check this", author: "Ann", initials: "A" },
        },
        { op: "set", target: "para:~5c74b0a5", value: { text: "Published 1 October 2026" } },
      ],
      [{ op: "set", target: "para:@27", value: { text: "Management reviewed each open risk (edited)." } }],
    ],
    action: { kind: "ops", entry: 0, ops: [0] },
    expect: "independent",
    control: true,
  },
  {
    fmt: "docx",
    name: "control: tracked set of the date paragraph, then set para:@27, reject-only the tracked batch (time-stamped)",
    batches: [
      [
        {
          op: "set",
          target: "para:~5c74b0a5",
          value: { text: "Published 1 October 2026" },
          track: { author: "Ann" },
        },
      ],
      [{ op: "set", target: "para:@27", value: { text: "Management reviewed each open risk (edited)." } }],
    ],
    action: { kind: "only", entry: 0 },
    expect: "independent",
    control: true,
  },
  // Added in the port (not in the prototype; also the "kept NOW()" xlsx control above): the controls
  // above reject the time-stamped op, so the kept session carries no time stamp and a reference replay
  // with the wrong clock would still match. These keep the time-stamped op (a comment, a tracked
  // change, a NOW() cache) and reject another one, so in the live pass the reference only matches when
  // it replays each batch at its proposal clock.
  {
    fmt: "docx",
    name: "control: comment on the title and set the date paragraph, then set para:@27, reject op 1 (kept comment time-stamped)",
    batches: [
      [
        {
          op: "insert",
          anchor: "para:~5525e827",
          position: "last-child",
          node: { kind: "comment", text: "Check this", author: "Ann", initials: "A" },
        },
        { op: "set", target: "para:~5c74b0a5", value: { text: "Published 1 October 2026" } },
      ],
      [{ op: "set", target: "para:@27", value: { text: "Management reviewed each open risk (edited)." } }],
    ],
    action: { kind: "ops", entry: 0, ops: [1] },
    expect: "independent",
    control: true,
  },
  {
    fmt: "docx",
    name: "control: tracked set of the date paragraph and set title, then set para:@27, reject op 1 (kept tracked change time-stamped)",
    batches: [
      [
        {
          op: "set",
          target: "para:~5c74b0a5",
          value: { text: "Published 1 October 2026" },
          track: { author: "Ann" },
        },
        { op: "set", target: "para:~5525e827", value: { text: "Harbor Ridge Logistics Group" } },
      ],
      [{ op: "set", target: "para:@27", value: { text: "Management reviewed each open risk (edited)." } }],
    ],
    action: { kind: "ops", entry: 0, ops: [1] },
    expect: "independent",
    control: true,
  },
  {
    fmt: "pptx",
    name: "cross-entry insert table row after row 2, then set row:@4/cell:@2",
    batches: [
      [
        {
          op: "insert-row",
          anchor: "slide:#257/shape:#3/row:@2",
          position: "after",
          cells: ["Forecast", "13.0", "13.5", "14.0", "14.5"],
          height_emu: 457200,
        },
      ],
      [{ op: "set", target: "slide:#257/shape:#3/row:@4/cell:@2", value: { text: "11.5" } }],
    ],
    action: { kind: "only", entry: 0 },
    expect: "coupled-or-refused",
  },
  {
    fmt: "pptx",
    name: "control: set two slide titles, reject op 0",
    batches: [
      [
        { op: "set", target: "slide:#256/shape:#2", value: { text: "Operating Review Pack FY26" } },
        { op: "set", target: "slide:#259/shape:#2", value: { text: "Next steps (draft)" } },
      ],
    ],
    action: { kind: "ops", entry: 0, ops: [0] },
    expect: "independent",
    control: true,
  },
];
