// Label and grouping cases built from the engine's documented example diffs (XLSX, PPTX, DOCX ops).
// They run without a kernel, so they pass on the current module and describe what a newer one reports.
import { describeEntry, revealTarget, type Change, type HistoryEntry, type Item, type Op } from "@wolfsdk/protocol";
import { BINDINGS, SHORTCUTS, matches } from "../../src/review/keys.ts";

type Ok = (c: unknown, m: string) => void;

function entry(
  changes: Change[],
  opts: { ops?: HistoryEntry["transaction"]["ops"]; map?: { before: string; after: string }[]; rawOps?: Op[] } = {},
): HistoryEntry {
  return {
    revision: 1,
    label: "x",
    source: "check",
    ops: opts.rawOps ?? [],
    diff: changes,
    transaction: {
      base_sha256: "a",
      result_sha256: "b",
      committed: true,
      address_map: opts.map ?? [],
      ops: opts.ops ?? [],
      diff: { changes, counts: {}, identity: "i" },
    },
    baseSha256: "a",
    resultSha256: "b",
    appliedAt: 0,
  };
}

const ch = (c: Partial<Change> & Pick<Change, "address" | "change" | "kind">): Change => ({ parts: [], ...c });
const str = (s: string) => ({ string: s });

export function runLabelChecks(ok: Ok): void {
  const labels = (items: Item[]) => items.map((i) => i.label);
  const names: Record<string, string> = { "slide:#256/shape:#2": "Title", "slide:#256/shape:#3": "Body" };
  const nameOf = (a: string) => names[a];

  // XLSX
  let items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/col:E",
        change: "modified",
        kind: "col",
        property: "format.column_width",
        before: { number: 8.43 },
        after: { number: 14 },
      }),
    ]),
  );
  ok(items[0]!.label === "Column E width 8.43 -> 14", `col width label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/row:@3",
        change: "modified",
        kind: "row",
        property: "format.row_height",
        before: { number: 15 },
        after: { number: 30 },
      }),
    ]),
  );
  ok(items[0]!.label === "Row 3 height 15 -> 30", `row height label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/col:B",
        change: "modified",
        kind: "col",
        property: "state",
        before: str("visible"),
        after: str("hidden"),
      }),
    ]),
  );
  ok(items[0]!.label === "Column B hidden", `col hidden label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/row:@3",
        change: "modified",
        kind: "row",
        property: "state",
        before: str("hidden"),
        after: str("visible"),
      }),
    ]),
  );
  ok(items[0]!.label === "Row 3 shown", `row shown label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2",
        change: "modified",
        kind: "sheet",
        property: "name",
        before: str("Data"),
        after: str("Inputs"),
      }),
    ]),
  );
  ok(items[0]!.label === "Sheet renamed Data -> Inputs", `rename label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/cell:B4",
        change: "modified",
        kind: "cell",
        property: "hyperlink",
        before: { empty: true },
        after: { url: "https://example.com/a" },
      }),
    ]),
  );
  ok(items[0]!.label === "Link added on B4", `link added: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/cell:A1",
        change: "modified",
        kind: "cell",
        property: "hyperlink",
        before: { empty: true },
        after: str("https://example.com/a"),
      }),
    ]),
  );
  ok(items[0]!.label === "Link added on A1", `link added (string form): ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/cell:A1",
        change: "modified",
        kind: "cell",
        property: "hyperlink",
        before: { location: "Data!A1" },
        after: { empty: true },
      }),
    ]),
  );
  ok(items[0]!.label === "Link removed on A1", `link removed: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/range:A1:B2",
        change: "modified",
        kind: "range",
        property: "merge",
        before: { empty: true },
        after: str("A1:B2"),
      }),
    ]),
  );
  ok(items[0]!.label === "Cells merged: A1:B2", `merge label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/range:A1:B2",
        change: "modified",
        kind: "range",
        property: "merge",
        before: str("A1:B2"),
        after: { empty: true },
      }),
    ]),
  );
  ok(items[0]!.label === "Cells unmerged: A1:B2", `unmerge label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2",
        change: "modified",
        kind: "sheet",
        property: "freeze",
        before: { empty: true },
        after: str("B2"),
      }),
    ]),
  );
  ok(items[0]!.label === "Freeze panes set", `freeze label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "sheet:#2/col:E",
        change: "modified",
        kind: "col",
        property: "format.column_width",
        before: { number: 8 },
        after: { number: 14 },
      }),
      ch({
        address: "sheet:#2/cell:B4",
        change: "modified",
        kind: "cell",
        property: "hyperlink",
        before: { empty: true },
        after: { url: "https://x.example/" },
      }),
      ch({
        address: "sheet:#2/cell:A1",
        change: "modified",
        kind: "cell",
        property: "value",
        before: { number: 1 },
        after: { number: 2 },
      }),
    ]),
  );
  ok(new Set(items.map((i) => i.group)).size === 3, "xlsx entry splits into three groups");
  ok(items[0]!.group === "Content", `content group first: ${items.map((i) => i.group)}`);

  // reveal for col/row addresses
  const have = new Set(["sheet:#2/cell:E1", "sheet:#2/cell:A3"]);
  ok(revealTarget("sheet:#2/col:E", (a) => have.has(a)) === "sheet:#2/cell:E1", "col reveals its first cell");
  ok(revealTarget("sheet:#2/row:@3", (a) => have.has(a)) === "sheet:#2/cell:A3", "row reveals its first cell");
  ok(revealTarget("sheet:#2/col:Z", (a) => have.has(a)) === null, "unknown col gives null");
  ok(revealTarget("sheet:#2/col:E", (a) => a === "sheet:#2/col:E") === "sheet:#2/col:E", "node address wins");

  // PPTX format collapse: shape + paragraph + runs agree
  const fmt = (address: string, property: string, before: unknown, after: unknown) =>
    ch({ address, change: "modified", kind: "x", property, before, after });
  const bold = (address: string) => fmt(address, "format.font.bold", { boolean: false }, { boolean: true });
  items = describeEntry(
    entry([
      bold("slide:#256/shape:#2"),
      bold("slide:#256/shape:#2/para:@1/run:@1"),
      bold("slide:#256/shape:#2/para:@2/run:@1"),
      fmt("slide:#256/shape:#2", "format.font.size", { number: 18 }, { number: 24 }),
      fmt("slide:#256/shape:#2/para:@1/run:@1", "format.font.size", { number: 18 }, { number: 24 }),
      fmt("slide:#256/shape:#2/para:@1", "format.alignment.horizontal", str("left"), str("center")),
      fmt("slide:#256/shape:#2", "format.alignment.horizontal", str("left"), str("center")),
    ]),
  );
  ok(items.length === 3, `format collapses to bold, size, alignment: ${labels(items)}`);
  ok(
    items.every((i) => i.group === "Formatting" && i.address === "slide:#256/shape:#2"),
    "format items sit on the shape",
  );
  ok(items.find((i) => i.label === "Bold on")!.indices.length === 3, "bold item keeps its three records");
  ok(items.find((i) => i.label === "Bold on")!.primary === 0, "primary is the shape-level record");
  items = describeEntry(
    entry([
      fmt("slide:#256/shape:#2/para:@1/run:@1", "format.font.size", { number: 18 }, { number: 24 }),
      fmt("slide:#256/shape:#2/para:@2/run:@1", "format.font.size", { number: 12 }, { number: 24 }),
    ]),
  );
  ok(items.length === 2, "different before values stay separate");

  // PPTX z-order names the OTHER shape: neutral label
  items = describeEntry(
    entry([
      ch({
        address: "slide:#256/shape:#3",
        change: "moved",
        kind: "shape",
        from: "slide:#256/shape:#3",
        before: { number: 2 },
        after: { number: 1 },
      }),
    ]),
    { nameOf },
  );
  ok(items[0]!.label === "Stacking order changed: Body", `z-order label: ${items[0]!.label}`);
  ok(items[0]!.notes[0] === "Body: position 2 -> 1", `z-order note: ${items[0]!.notes}`);
  items = describeEntry(
    entry([
      ch({
        address: "slide:#256/shape:#3",
        change: "moved",
        kind: "shape",
        before: { number: 2 },
        after: { number: 1 },
      }),
      ch({
        address: "slide:#256/shape:#4",
        change: "moved",
        kind: "shape",
        before: { number: 3 },
        after: { number: 2 },
      }),
    ]),
  );
  ok(items.length === 1 && items[0]!.indices.length === 2, "z-order shapes of one slide fold into one entry");

  // PPTX geometry, slide move, copy, picture insert
  const geo = (p: string, b: number, a: number) =>
    ch({
      address: "slide:#256/shape:#2",
      change: "modified",
      kind: "shape",
      property: p,
      before: { number: b },
      after: { number: a },
    });
  items = describeEntry(entry([geo("geometry.x", 731520, 1645920), geo("geometry.y", 457200, 1371600)]), { nameOf });
  ok(
    items.length === 1 &&
      items[0]!.label === "Title moved (points)" &&
      items[0]!.values?.before === "57.6, 36" &&
      items[0]!.values.after === "129.6, 108",
    `move label: ${JSON.stringify(items[0])}`,
  );
  items = describeEntry(entry([geo("geometry.cx", 6858000, 3000000), geo("geometry.cy", 1097280, 500000)]), { nameOf });
  ok(items.length === 1 && items[0]!.label === "Title resized (points)", `resize label: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "slide:#258",
        change: "moved",
        kind: "slide",
        from: "slide:#258",
        before: { number: 3 },
        after: { number: 5 },
      }),
    ]),
  );
  ok(items[0]!.label === "Slide moved 3 -> 5", `slide move: ${items[0]!.label}`);
  items = describeEntry(entry([ch({ address: "slide:#258", change: "added", kind: "slide" })]));
  ok(items[0]!.label === "Slide added", `slide copy: ${items[0]!.label}`);
  items = describeEntry(entry([ch({ address: "slide:#256/shape:#4", change: "added", kind: "shape" })]), {
    nameOf: () => "Copy of Title",
  });
  ok(items[0]!.label === "Shape added: Copy of Title", `shape copy: ${items[0]!.label}`);
  items = describeEntry(
    entry([ch({ address: "slide:#256/shape:#4", change: "added", kind: "shape" })], {
      ops: [{ index: 0, op: "insert", created: "slide:#256/shape:#4", resolved: "slide:#256" }] as never,
      rawOps: [{ op: "insert", anchor: "slide:#256", position: "last-child", node: { kind: "image" } }] as never,
    }),
    { nameOf: () => "Logo" },
  );
  ok(items[0]!.label === "Picture added: Logo", `picture insert: ${items[0]!.label}`);

  // DOCX
  const oldT = "table:~321a8b03";
  const newT = "table:~99aa0011";
  const rows = [0, 1, 2].flatMap((n) => [
    ch({ address: `${oldT}/row:@${n}`, change: "removed", kind: "row" }),
    ch({ address: `${newT}/row:@${n}`, change: "added", kind: "row" }),
  ]);
  items = describeEntry(
    entry(
      [
        ...rows,
        ch({
          address: "para:@9",
          change: "modified",
          kind: "paragraph",
          property: "text",
          before: str("a"),
          after: str("b"),
        }),
      ],
      {
        ops: [{ index: 0, op: "delete-column", resolved: oldT }],
        map: [{ before: oldT, after: newT }],
        rawOps: [{ op: "delete-column", target: oldT, index: 1 }] as unknown as Op[],
      },
    ),
  );
  ok(items.length === 2, `delete-column folds into one entry plus the text edit: ${labels(items)}`);
  ok(
    items.some((i) => i.label === "Table column 2 deleted" && i.indices.length === 6),
    `delete-column label: ${labels(items)}`,
  );
  items = describeEntry(entry([ch({ address: "para:@1/image:@1", change: "removed", kind: "image" })]));
  ok(items[0]!.label === "Picture deleted", `picture delete: ${items[0]!.label}`);
  items = describeEntry(
    entry([
      ch({
        address: "comment:#0",
        change: "modified",
        kind: "comment",
        property: "text",
        before: str("old"),
        after: str("Cite policy 4.2\nand the date."),
      }),
    ]),
  );
  ok(items[0]!.label === "Comment edited", `comment edit: ${items[0]!.label}`);
  // strike / highlight / tracked typing / insert-column / keys
  const run = (address: string, property: string, before: unknown, after: unknown) =>
    ch({ address, change: "modified", kind: "run", property, before, after });
  const one = (c: Change) => describeEntry(entry([c]))[0]!.label;
  ok(
    one(run("para:@1/run:@1", "format.font.strike", { boolean: false }, { boolean: true })) === "Strikethrough on",
    "strike on",
  );
  ok(
    one(run("para:@1/run:@1", "format.strike", { boolean: true }, { boolean: false })) === "Strikethrough off",
    "strike off (run format member)",
  );
  ok(
    one(run("para:@1/run:@1", "format.font.highlight", str("none"), str("yellow"))) === "Highlight: Yellow",
    "highlight yellow",
  );
  ok(
    one(run("para:@1/run:@1", "format.font.highlight", str("none"), str("darkBlue"))) === "Highlight: Dark blue",
    "highlight darkBlue",
  );
  ok(
    one(run("para:@1/run:@1", "format.font.highlight", str("yellow"), str("none"))) === "Highlight removed",
    "highlight removed",
  );
  const trackedChanges = [
    ch({
      address: "para:@1",
      change: "modified",
      kind: "paragraph",
      property: "text",
      before: str("the supplier"),
      after: str("the vendor"),
    }),
    ch({ address: "revision:#0", change: "added", kind: "revision", revision_kind: "del", text: "supplier" }),
    ch({ address: "revision:#1", change: "added", kind: "revision", revision_kind: "ins", text: "vendor" }),
  ];
  items = describeEntry(
    entry(trackedChanges, { ops: [{ index: 0, op: "splice-text", revisions: ["revision:#0", "revision:#1"] }] }),
  );
  ok(items.length === 2, `tracked typing is one change plus the text record: ${labels(items)}`);
  ok(
    items.some((i) => i.label === 'Tracked edit: deleted "supplier", inserted "vendor"' && i.indices.length === 2),
    `tracked label: ${labels(items)}`,
  );
  items = describeEntry(
    entry([ch({ address: "revision:#7", change: "added", kind: "revision" })], {
      ops: [{ index: 0, op: "splice-text", revisions: ["revision:#7"] }],
    }),
    {
      nodeOf: () => ({ text: "hello", revision_kind: "ins" }),
    },
  );
  ok(items[0]!.label === 'Tracked edit: inserted "hello"', `tracked label from node: ${items[0]!.label}`);
  items = describeEntry(entry([ch({ address: "revision:#7", change: "added", kind: "revision" })]));
  ok(
    items[0]!.label === "Tracked edit (0 deletions, 0 insertions)" || items[0]!.label === "Tracked edit",
    `tracked without detail: ${items[0]!.label}`,
  );
  items = describeEntry(
    entry([ch({ address: `${newT}/row:@0`, change: "added", kind: "row" })], {
      ops: [{ index: 0, op: "insert-column", resolved: oldT }],
      map: [{ before: oldT, after: newT }],
      rawOps: [{ op: "insert-column", anchor: oldT, index: 0 }] as unknown as Op[],
    }),
  );
  ok(items[0]!.label === "Table column 1 inserted", `insert-column is 1-based in the label: ${items[0]!.label}`);
  const key = (
    k: string,
    mods: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>> = {},
    code = "",
  ) => ({ key: k, code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });
  ok(matches(key("ArrowDown", { altKey: true }), "Alt+ArrowDown"), "alt+down matches");
  ok(!matches(key("ArrowDown"), "Alt+ArrowDown"), "plain down is not alt+down");
  ok(matches(key("\u00e5", { altKey: true, shiftKey: true }, "KeyA"), "Alt+Shift+A"), "option letters match by code");
  ok(!matches(key("a", { altKey: true }), "Alt+Shift+A"), "missing shift does not match");
  ok(new Set(SHORTCUTS.map((s) => s.keys + (s.when ?? ""))).size === SHORTCUTS.length, "shortcut keys are unique");
  ok(
    SHORTCUTS.length === BINDINGS.length && SHORTCUTS.every((s) => s.label && s.group),
    "every binding is declared with a label and group",
  );
}
