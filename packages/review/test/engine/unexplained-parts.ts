// Check `unexplained-parts`: package parts the engine's save drops or rewrites, found against the edited
// result, on the node reactor kernel of the pinned module. Ported from the prototype review package's
// unexplained-check.ts; `run(ctx, format)` runs the cases whose base file has `format`.
//   1. The first 8 batches of the recorded session: every changed part is checked against the change
//      records and parts_written of the entries.
//   2. Seeded single ops (several fixtures), recording whether the engine's change records name every
//      part the op changed (the engine's naming coverage, as measured), with the expected part names.
//   3. A tampered result (one untouched part rewritten outside the engine) must be flagged `unreported`,
//      including a link table whose existing relationship is retargeted.
//   4. An op followed by its inverse: the part lands in `claimedButUnchanged`, or the leftover is reported
//      (XLSX only, the seed is a sheet cell).
//   5. The reviewer sentence of every verdict (format independent, runs on each format).
// Nothing here is skipped: the prototype's check ran on the same kernel (no native or wasm replay) and
// uses no optional module command.
import { inflateRawSync } from "node:zlib";
import { buildPartsReport, comparePackages, describeFinding, listParts } from "@wolfsdk/protocol";
import type { KernelClient, Op, PartsReport } from "@wolfsdk/protocol";
import { createEditorHost } from "../../src/host/host.ts";
import type { HistoryEntry } from "../../src/host/index.ts";
import { BASE, createAsserter, fixtureBytes, sessionBatches } from "./harness.ts";
import type { Asserter, CheckOutcome, EngineContext, Format } from "./harness.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const enc = new TextEncoder();
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ---- store-only ZIP re-pack (tamper case) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file entry's name and uncompressed bytes, in central-directory order (no ZIP64, methods 0 and 8). */
function unzip(zip: Uint8Array): { name: string; data: Uint8Array }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("unzip: no end record");
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error(`unzip: bad central header ${i}`);
    const method = v.getUint16(at + 10, true);
    const csize = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const offset = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (csize === 0xffffffff || offset === 0xffffffff) throw new Error("unzip: zip64 not handled");
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const packed = zip.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`unzip: method ${method} for ${name}`);
    if (!name.endsWith("/")) out.push({ name, data: method === 8 ? new Uint8Array(inflateRawSync(packed)) : packed });
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

/** Store-only archive of `items`, in order. */
function zipStored(items: { name: string; data: Uint8Array }[]): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff);
  const u32 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const header = (crc: number, size: number, name: Uint8Array) => {
    u16(20); // version needed
    u16(0x0800); // UTF-8 names
    u16(0); // stored
    u16(0); // time
    u16(0x21); // date 1980-01-01
    u32(crc);
    u32(size);
    u32(size);
    u16(name.length);
  };
  const rows = items.map((it) => {
    const name = enc.encode(it.name);
    const crc = crc32(it.data);
    const offset = out.length;
    u32(0x04034b50);
    header(crc, it.data.length, name);
    u16(0);
    for (const b of name) out.push(b);
    for (const b of it.data) out.push(b);
    return { name, crc, size: it.data.length, offset };
  });
  const cd = out.length;
  for (const r of rows) {
    u32(0x02014b50);
    u16(20); // version made by
    header(r.crc, r.size, r.name);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(r.offset);
    for (const b of r.name) out.push(b);
  }
  const cdSize = out.length - cd;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(rows.length);
  u16(rows.length);
  u32(cdSize);
  u32(cd);
  u16(0);
  return new Uint8Array(out);
}

// ---- kernel runs ----
type Run = { original: Uint8Array; saved: Uint8Array; history: HistoryEntry[]; report: PartsReport };

/** Opens a fixture (default: the format's session base), applies each batch as one entry, saves; `refused` if a batch fails. */
async function replay(
  kernel: KernelClient,
  format: Format,
  batches: Op[][],
  file: string = BASE[format],
): Promise<Run | { refused: string }> {
  const host = createEditorHost(kernel);
  const original = fixtureBytes(`${format}/${file}`);
  try {
    await host.open(original, file);
    for (const [i, ops] of batches.entries()) {
      const r = await host.apply(ops, { label: `batch ${i + 1}`, source: "unexplained-parts", quiet: true });
      if (!r.ok) return { refused: `${r.error.code}: ${r.error.message}` };
    }
    const saved = await host.save();
    const history = host.getSnapshot().history;
    return { original, saved, history, report: buildPartsReport(original, saved, history) };
  } finally {
    await host.close();
  }
}

const names = (e: HistoryEntry): Set<string> =>
  new Set((e.transaction.diff?.changes ?? e.diff).flatMap((c) => c.parts ?? []).map((p) => p.replace(/^\//, "")));
const written = (e: HistoryEntry): Set<string> => {
  const w: unknown = e.transaction.parts_written;
  return new Set(Array.isArray(w) ? w.map((p) => String(p).replace(/^\//, "")) : []);
};

/** The report agrees with the bytes and with the entries it cites. */
function consistent(ok: Asserter, tag: string, r: Run): void {
  const byRev = new Map(r.history.map((e) => [e.revision, e]));
  const content = comparePackages(r.original, r.saved).deltas.filter((d) => d.status !== "recompressed");
  ok(r.report.changed === content.length, `${tag}: changed ${r.report.changed} = comparePackages ${content.length}`);
  ok(r.report.findings.length === r.report.changed, `${tag}: one finding per changed part`);
  for (const f of r.report.findings) {
    for (const rev of f.namedBy) ok(names(byRev.get(rev)!).has(f.name), `${tag}: revision ${rev} names ${f.name}`);
    for (const rev of f.writtenBy) ok(written(byRev.get(rev)!).has(f.name), `${tag}: revision ${rev} wrote ${f.name}`);
    const namedAnywhere = r.history.some((e) => names(e).has(f.name));
    const writtenAnywhere = r.history.some((e) => written(e).has(f.name));
    ok(
      namedAnywhere === f.namedBy.length > 0 && writtenAnywhere === f.writtenBy.length > 0,
      `${tag}: ${f.name} citations complete`,
    );
    const want = namedAnywhere ? "explained" : writtenAnywhere ? "unnamed" : "unreported";
    ok(f.verdict === want, `${tag}: ${f.name} verdict ${f.verdict}, expected ${want}`);
    if (f.verdict !== "explained") ok(r.report.unexplained.includes(f), `${tag}: ${f.name} listed as unexplained`);
    const sizes = (zip: Uint8Array) =>
      new Map(listParts(zip).map((p) => [p.name.replace(/^\//, ""), p.uncompressedSize]));
    ok(f.detail, `${tag}: ${f.name} has detail`);
    ok(
      f.detail.sizeBefore === (sizes(r.original).get(f.name) ?? null) &&
        f.detail.sizeAfter === (sizes(r.saved).get(f.name) ?? null),
      `${tag}: ${f.name} sizes ${f.detail.sizeBefore} -> ${f.detail.sizeAfter}`,
    );
    ok(
      f.name.endsWith(".rels") === (f.detail.relationships !== undefined),
      `${tag}: ${f.name} relationships only for .rels`,
    );
    if (f.detail.relationships) {
      // Cross-check the protocol's own inflater and scanner against node:zlib and a plain element count.
      const rels = (zip: Uint8Array) =>
        dec(unzip(zip).find((it) => it.name.replace(/^\//, "") === f.name)?.data ?? new Uint8Array()).split(
          "<Relationship ",
        ).length - 1;
      const { added, removed } = f.detail.relationships;
      ok(
        added.length - removed.length === rels(r.saved) - rels(r.original),
        `${tag}: ${f.name} relationship counts agree with node:zlib`,
      );
    }
  }
  ok(
    r.report.unexplained.every((f) => f.verdict !== "explained"),
    `${tag}: unexplained holds only unexplained`,
  );
}

/** Seeded single-op cases on the pinned module.
 *  `expect` records what the prototype observed on 2026-11-12 on its own module: the number of content-changed parts
 *  and the ones no change record names. This check asserts the same values on the pinned module. */
type Seed = { fmt: Format; file?: string; label: string; ops: Op[]; expect: { changed: number; unexplained: string[] } };
const IMAGE = { kind: "image", media_type: "image/png", data: PNG_1X1, alt_text: "dot" };
const SEEDS: Seed[] = [
  // Observed: the new hyperlink's relationship is written but only word/document.xml is named.
  {
    fmt: "docx",
    label: "insert-hyperlink (url)",
    ops: [
      {
        op: "insert-hyperlink",
        anchor: "para:~86bd68b3",
        position: "last-child",
        text: " See site",
        url: "https://example.com/a",
      },
    ],
    expect: { changed: 2, unexplained: ["word/_rels/document.xml.rels"] },
  },
  // Observed: the picture's relationship and the media file are written, neither is named.
  {
    fmt: "docx",
    label: "insert image",
    ops: [
      {
        op: "insert",
        anchor: "para:~86bd68b3",
        position: "after",
        node: { ...IMAGE, extent: { cx_emu: 914400, cy_emu: 914400 } },
      },
    ],
    expect: { changed: 3, unexplained: ["word/_rels/document.xml.rels", "word/media/image1.png"] },
  },
  // Observed: the table is already in descending Q3 order, so nothing is written.
  {
    fmt: "xlsx",
    label: "sort table:Regions descending (already in order)",
    ops: [{ op: "sort", target: "table:Regions", keys: [{ col: "Q3", order: "descending" }] }],
    expect: { changed: 0, unexplained: [] },
  },
  // Observed: the rows move inside sheet1.xml, which is named.
  {
    fmt: "xlsx",
    label: "sort table:Regions ascending",
    ops: [{ op: "sort", target: "table:Regions", keys: [{ col: "Q3" }] }],
    expect: { changed: 1, unexplained: [] },
  },
  // Observed: the external link's sheet relationships part is named.
  {
    fmt: "xlsx",
    label: "hyperlink (url)",
    ops: [
      {
        op: "hyperlink",
        target: "sheet:Summary/cell:A1",
        action: "set",
        url: "https://example.com/a",
        tooltip: "Open",
      },
    ],
    expect: { changed: 2, unexplained: [] },
  },
  // Observed: names-tables.xlsx has no shared strings part; only the sheet changes.
  {
    fmt: "xlsx",
    label: "set string (no shared strings part)",
    ops: [{ op: "set", target: "sheet:Regions/cell:E3", value: { string: "Delta" } }],
    expect: { changed: 1, unexplained: [] },
  },
  // Observed: the new text is written as an inline string, so xl/sharedStrings.xml does not change.
  {
    fmt: "xlsx",
    file: "chart-line.xlsx",
    label: "set string, chart-line.xlsx (has shared strings)",
    ops: [{ op: "set", target: "sheet:#1/cell:E1", value: { string: "Note" } }],
    expect: { changed: 1, unexplained: [] },
  },
  // Observed: the table's range moves with the rows, but xl/tables/table1.xml is not named.
  {
    fmt: "xlsx",
    label: "insert row in table sheet",
    ops: [{ op: "insert", anchor: "sheet:Regions/row:@5", position: "before", node: { kind: "row" } }],
    expect: { changed: 3, unexplained: ["xl/tables/table1.xml"] },
  },
  // Observed: the defined names in xl/workbook.xml are rewritten, and workbook.xml is named.
  {
    fmt: "xlsx",
    file: "model-finance.xlsx",
    label: "insert row, model-finance.xlsx (defined names)",
    ops: [{ op: "insert", anchor: "sheet:Assumptions/row:@3", position: "before", node: { kind: "row" } }],
    expect: { changed: 3, unexplained: [] },
  },
  // Observed: only the new slide is named; presentation, content types, relationships and the notes copy are not.
  {
    fmt: "pptx",
    label: "insert slide (duplicate)",
    ops: [{ op: "insert", anchor: "slide:#256", position: "after", node: { kind: "slide", from: "slide:#256" } }],
    expect: {
      changed: 7,
      unexplained: [
        "[Content_Types].xml",
        "ppt/_rels/presentation.xml.rels",
        "ppt/notesSlides/_rels/notesSlide10.xml.rels",
        "ppt/notesSlides/notesSlide10.xml",
        "ppt/presentation.xml",
        "ppt/slides/_rels/slide14.xml.rels",
      ],
    },
  },
  // Observed: as for the duplicate, only the new slide is named (no notes copy here).
  {
    fmt: "pptx",
    label: "insert slide (layout Title Only)",
    ops: [
      {
        op: "insert",
        anchor: "slide:#257",
        position: "after",
        node: { kind: "slide", style: "Title Only", text: "Styled title" },
      },
    ],
    expect: {
      changed: 5,
      unexplained: [
        "[Content_Types].xml",
        "ppt/_rels/presentation.xml.rels",
        "ppt/presentation.xml",
        "ppt/slides/_rels/slide14.xml.rels",
      ],
    },
  },
  // Observed: the picture's slide relationship and media file are not named.
  {
    fmt: "pptx",
    label: "insert image",
    ops: [
      {
        op: "insert",
        anchor: "slide:#256",
        position: "last-child",
        node: { ...IMAGE, offset: { x_emu: 914400, y_emu: 914400 }, extent: { cx_emu: 914400, cy_emu: 914400 } },
      },
    ],
    expect: { changed: 3, unexplained: ["ppt/media/image2.png", "ppt/slides/_rels/slide1.xml.rels"] },
  },
];

type CaseRow = {
  case: string;
  changed: number;
  explained: number;
  unnamed: number;
  unreported: number;
  /** `name (verdict)` per unexplained part. */
  unexplainedParts: string[];
  explainedParts: string[];
  claimedButUnchanged: string[];
};

export async function run(ctx: EngineContext, format: Format): Promise<CheckOutcome> {
  const ok: Asserter = createAsserter();
  const kernel = ctx.kernel();
  const rows: CaseRow[] = [];
  const notes: string[] = [];
  const sentences = new Set<string>();
  /** Records one report: a row for the evidence file and one note line; its unexplained parts' sentences are kept. */
  const record = (label: string, r: PartsReport): void => {
    for (const f of r.unexplained) sentences.add(describeFinding(f));
    const explained = r.findings.filter((f) => f.verdict === "explained");
    const row: CaseRow = {
      case: label,
      changed: r.changed,
      explained: explained.length,
      unnamed: r.findings.filter((f) => f.verdict === "unnamed").length,
      unreported: r.findings.filter((f) => f.verdict === "unreported").length,
      unexplainedParts: r.unexplained.map((f) => `${f.name} (${f.verdict})`),
      explainedParts: explained.map((f) => f.name),
      claimedButUnchanged: r.claimedButUnchanged,
    };
    rows.push(row);
    notes.push(
      `${label}: changed ${row.changed}, explained ${row.explained}, unnamed ${row.unnamed}, unreported ${row.unreported}; unexplained ${row.unexplainedParts.join(", ") || "-"}`,
    );
  };

  // 1. Session baseline.
  const batches = sessionBatches(format).slice(0, 8);
  const base = await replay(kernel, format, batches);
  ok(!("refused" in base), `${format}: 8 session batches apply (${"refused" in base ? base.refused : ""})`);
  ok(
    base.history.length === 8 && base.report.revisions.join() === "1,2,3,4,5,6,7,8",
    `${format}: revisions 1..8`,
  );
  consistent(ok, `${format} session`, base);
  record("session-20 batches 1-8", base.report);
  if (format === "docx") {
    // Observed: in the DOCX session the hyperlink batch (7) writes the relationships part without naming it.
    ok(
      base.report.unexplained.map((f) => `${f.name} ${f.verdict} ${f.writtenBy}`).join() ===
        "word/_rels/document.xml.rels unnamed 7",
      `docx session: one unnamed part (${base.report.unexplained.map((f) => `${f.name} ${f.verdict} ${f.writtenBy}`).join() || "none"})`,
    );
  } else {
    ok(
      base.report.unexplained.length === 0,
      `${format} session: all explained (${base.report.unexplained.map((f) => f.name).join() || "none"})`,
    );
  }

  // 2. Seeded ops.
  const seeds = SEEDS.filter((s) => s.fmt === format);
  ok(seeds.length > 0, `${format}: has seeded single-op cases`);
  for (const s of seeds) {
    const tag = `${s.fmt} ${s.label}`;
    const r = await replay(kernel, s.fmt, [s.ops], s.file);
    ok(!("refused" in r), `${tag}: applies (${"refused" in r ? r.refused : ""})`);
    consistent(ok, tag, r);
    record(s.label, r.report);
    const got = r.report.unexplained.map((f) => f.name).join();
    ok(
      r.report.changed === s.expect.changed,
      `${tag}: ${r.report.changed} parts changed, observed ${s.expect.changed}`,
    );
    ok(got === s.expect.unexplained.join(), `${tag}: unexplained ${got}, observed ${s.expect.unexplained.join()}`);
    // Observed: the DOCX hyperlink's relationship is the one unnamed part, and its table gained exactly the op's URL.
    const first = s.ops[0]!;
    if (first.op === "insert-hyperlink") {
      const rel = r.report.unexplained[0]!.detail!.relationships!;
      ok(
        rel.added.length === 1 &&
          rel.added[0]!.external &&
          rel.added[0]!.type === "hyperlink" &&
          rel.added[0]!.target === first.url,
        `${tag}: one added outside hyperlink to the op's URL (${JSON.stringify(rel)})`,
      );
      ok(rel.removed.length === 0 && rel.changed.length === 0, `${tag}: no relationship removed or retargeted`);
      const text = describeFinding(r.report.unexplained[0]!);
      ok(
        text.includes("gained 1 outside link to https://example.com/a"),
        `${tag}: sentence names the new outside link: ${text}`,
      );
    }
  }

  // 3. Tamper: rewrite one part that no entry named or wrote, outside the engine.
  {
    const claimed = new Set(base.history.flatMap((e) => [...names(e), ...written(e)]));
    const changed = new Set(base.report.findings.map((f) => f.name));
    const items = unzip(base.saved);
    const victim = items.find((it) => it.name.endsWith(".xml") && !claimed.has(it.name) && !changed.has(it.name));
    ok(victim, `${format}: some part is untouched by the entries`);
    const repacked = zipStored(items);
    ok(listParts(repacked).length === items.length, `${format}: re-pack keeps every part`);
    const plain = buildPartsReport(base.original, repacked, base.history);
    ok(
      JSON.stringify(plain.findings) === JSON.stringify(base.report.findings),
      `${format}: store-only re-pack alone changes no finding`,
    );
    const tampered = zipStored(
      items.map((it) =>
        it === victim ? { name: it.name, data: new Uint8Array([...it.data, ...enc.encode("<!-- x -->")]) } : it,
      ),
    );
    const t = buildPartsReport(base.original, tampered, base.history);
    const extra = t.findings.filter((f) => !base.report.findings.some((g) => g.name === f.name));
    ok(
      extra.length === 1 && extra[0]!.name === victim.name,
      `${format}: tamper adds exactly ${victim.name} (${extra.map((f) => f.name)})`,
    );
    ok(extra[0]!.verdict === "unreported" && extra[0]!.status === "changed", `${format}: ${victim.name} is unreported`);
    ok(
      t.unexplained.some((f) => f.name === victim.name),
      `${format}: tampered part is unexplained`,
    );
    record(`tamper ${victim.name}`, t);
  }

  // 3b. Tamper: retarget the first relationship of a link table no entry touched. The new Target uses single
  // quotes and an entity, so the scanner's tolerance is exercised too.
  {
    const EVIL = "https://attacker.example/a?x=1&y=2";
    const claimed = new Set(base.history.flatMap((e) => [...names(e), ...written(e)]));
    const changed = new Set(base.report.findings.map((f) => f.name));
    const items = unzip(base.saved);
    const victim = items.find(
      (it) =>
        it.name.endsWith(".rels") &&
        !claimed.has(it.name) &&
        !changed.has(it.name) &&
        dec(it.data).includes("<Relationship "),
    );
    ok(victim, `${format}: some link table is untouched by the entries`);
    const xml = dec(victim.data);
    const first = /<Relationship [^>]*>/.exec(xml)![0];
    const oldTarget = /Target="([^"]*)"/.exec(first)![1]!;
    const id = /Id="([^"]*)"/.exec(first)![1]!;
    const rewritten = first.replace(/ Target="[^"]*"/, ` TargetMode="External" Target='${EVIL.replace("&", "&amp;")}'`);
    const data = enc.encode(xml.replace(first, rewritten));
    const t = buildPartsReport(
      base.original,
      zipStored(items.map((it) => (it === victim ? { name: it.name, data } : it))),
      base.history,
    );
    const extra = t.findings.filter((f) => !base.report.findings.some((g) => g.name === f.name));
    ok(
      extra.length === 1 && extra[0]!.name === victim.name && extra[0]!.verdict === "unreported",
      `${format}: retargeted ${victim.name} is the one unreported addition`,
    );
    const rel = extra[0]!.detail!.relationships!;
    const c = rel.changed[0];
    ok(
      rel.changed.length === 1 &&
        rel.added.length === 0 &&
        rel.removed.length === 0 &&
        c!.before.id === id &&
        c!.after.id === id,
      `${format}: one changed relationship ${id} (${JSON.stringify(rel)})`,
    );
    ok(
      c!.before.target === oldTarget && !c!.before.external && c!.after.target === EVIL && c!.after.external,
      `${format}: before and after targets`,
    );
    const text = describeFinding(extra[0]!);
    ok(
      text.includes(`Link ${id} became an outside link: it now points to ${EVIL} instead of ${oldTarget}`),
      `${format}: sentence says the link went outside: ${text}`,
    );
    record(`retarget ${id} in ${victim.name}`, t);
  }

  // 4. Reverted change: set XLSX C4 to 10000, then back to the value its change record says it had.
  if (format === "xlsx") {
    const set: Op = { op: "set", target: "sheet:Regions/cell:C4", value: { number: 10000 } };
    const first = await replay(kernel, "xlsx", [[set]]);
    ok(!("refused" in first), "xlsx revert: first set applies");
    const rec = (first.history[0]!.transaction.diff?.changes ?? first.history[0]!.diff).find(
      (c) => c.cause === 0 && c.change === "modified" && c.property === "value",
    );
    ok(rec && rec.before !== undefined, `xlsx revert: C4 change record carries the old value (${JSON.stringify(rec)})`);
    const back = await replay(kernel, "xlsx", [
      [set],
      [{ op: "set", target: "sheet:Regions/cell:C4", value: rec.before as never }],
    ]);
    ok(!("refused" in back), `xlsx revert: round trip applies (${"refused" in back ? back.refused : ""})`);
    consistent(ok, "xlsx revert", back);
    record(`set C4 to 10000, then back to ${JSON.stringify(rec.before)}`, back.report);
    notes.push(`reverted change: claimedButUnchanged ${back.report.claimedButUnchanged.join(", ") || "-"}`);
    // Observed: sheet2.xml (the Summary sheet, whose cached formula results follow C4) is byte-identical again
    // and lands in claimedButUnchanged. sheet1.xml still differs: the engine rewrites C4 without its
    // redundant t="n" (number is the default cell type), so the round trip is not byte-exact there.
    ok(
      back.report.claimedButUnchanged.join() === "xl/worksheets/sheet2.xml",
      `xlsx revert: sheet2.xml claimed but unchanged (${back.report.claimedButUnchanged.join() || "none"})`,
    );
    ok(
      back.report.findings.map((f) => `${f.name} ${f.verdict}`).join() === "xl/worksheets/sheet1.xml explained",
      `xlsx revert: sheet1.xml still changed, explained (${back.report.findings.map((f) => `${f.name} ${f.verdict}`).join()})`,
    );
    const xml = (zip: Uint8Array) => dec(unzip(zip).find((it) => it.name === "xl/worksheets/sheet1.xml")!.data);
    const was = xml(back.original);
    const bare = was.replace('<c r="C4" s="3" t="n">', '<c r="C4" s="3">');
    ok(bare !== was && bare === xml(back.saved), 'xlsx revert: the only leftover in sheet1.xml is C4 losing t="n"');
    notes.push(
      'sheet1.xml leftover: C4 written as <c r="C4" s="3"> instead of <c r="C4" s="3" t="n"> (same value, same type)',
    );
  }

  // 5. describeFinding (format independent: runs on every format).
  let sentenceCount = 0;
  for (const verdict of ["explained", "unnamed", "unreported"] as const)
    for (const name of [
      "word/_rels/document.xml.rels",
      "xl/sharedStrings.xml",
      "docProps/app.xml",
      "ppt/slides/slide2.xml",
      "x/y.bin",
    ]) {
      const s = describeFinding({
        name,
        status: "changed",
        namedBy: verdict === "explained" ? [1] : [],
        writtenBy: verdict === "unnamed" ? [2] : [],
        verdict,
      });
      ok(
        s.length > name.length + 20 && s.endsWith(".") && !s.includes("\u2014"),
        `describeFinding ${verdict} ${name}: ${s}`,
      );
      ok(
        !/OOXML|OPC|xmlns|<|ContentType/.test(s.replace(name, "")),
        `describeFinding ${verdict} ${name}: no jargon: ${s}`,
      );
      sentenceCount++;
    }
  notes.push(`describeFinding: ${sentenceCount} synthetic findings (3 verdicts x 5 part kinds) give a plain closed sentence`);
  notes.push(`${sentences.size} distinct reviewer sentence${sentences.size === 1 ? "" : "s"} for the unexplained parts above`);

  return {
    checks: ok.count,
    notes,
    data: { cases: rows, sentences: [...sentences] },
  };
}
