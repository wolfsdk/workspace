// A whole pack: load, check, refresh, refuse, and refresh into a room. The documents are built in memory and the
// engine is the package's own applier, so every expectation below is a thing the pack itself can say.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackBinding, PackManifest, RoomActor } from "@wolfsdk/protocol/workspace";
import type { ReplayInput, ReplayResult } from "@wolfsdk/server";
import { RoomServer } from "@wolfsdk/server";
import { PackError } from "../src/errors.ts";
import { checkPack, loadPack, refreshPack, refreshPackInRoom } from "../src/pack.ts";
import { DirectoryStore, MemoryStore } from "../src/store.ts";
import { evaluatorFor, LocalEngine } from "./evaluators.ts";
import { binding, bytesOf, codeOf, docx, manifest, manifestBytes, partText, pptx, QUARTERS, sha256, STYLE, xlsx } from "./fixtures.ts";

const range = (ref: string) => ({ type: "range", sheet: "Fin", ref }) as const;

const BINDINGS: PackBinding[] = [
  binding({ id: "docx-table", target_kind: "docx_table", target_address: "Revenue", selector: range("A1:B4"), fit_policy: "grow" }),
  binding({ id: "docx-headline", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" } }),
  binding({ id: "pptx-title", target_kind: "pptx_fit_headline", target_address: "slide:@1/shape:Title 1", selector: { type: "cell", sheet: "Fin", ref: "A2" }, fit_policy: "shrink_to_fit" }),
  binding({ id: "pptx-table", target_kind: "pptx_table", target_address: "slide:@1/shape:Table 1", selector: range("A1:B3"), fit_policy: "grow" }),
  binding({ id: "pptx-chart", target_kind: "pptx_chart_series", target_address: "slide:@1/shape:Chart 1/chart/series:Sales", selector: range("B2:B4") }),
];

const WORKBOOK = (): Uint8Array => xlsx({ rows: QUARTERS, names: { Headline: "Fin!$B$2" } });

function files(m: PackManifest = manifest(BINDINGS), extra: [string, Uint8Array][] = []): [string, Uint8Array][] {
  return [["pack.wolf.json", manifestBytes(m)], ["fin.xlsx", WORKBOOK()], ["deck.docx", docx()], ["deck.pptx", pptx()], ...extra];
}

const hashes = (store: MemoryStore): Record<string, string> => Object.fromEntries([...store.files].map(([name, bytes]) => [name, sha256(bytes)]));
const bytesFrom = (store: MemoryStore, name: string): Uint8Array => {
  const bytes = store.files.get(name);
  if (bytes === undefined) throw new Error(`no ${name}`);
  return bytes;
};

describe("loading a pack", () => {
  test("names a manifest that is missing, not JSON, or not a pack", async () => {
    expect(await codeOf(() => loadPack(new MemoryStore()))).toBe("manifest-missing");
    expect(await codeOf(() => loadPack(new MemoryStore([["pack.wolf.json", bytesOf("{")]])))).toBe("manifest-invalid");
    const wrong = new MemoryStore([["pack.wolf.json", bytesOf(JSON.stringify({ contract: "wolfsdk.pack.v1" }))]]);
    expect(await codeOf(() => loadPack(wrong))).toBe("manifest-invalid");
    const error = await loadPack(wrong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackError);
    expect(error instanceof PackError ? error.problems.length : 0).toBeGreaterThan(0);
  });

  test("returns the manifest it validated", async () => {
    const m = manifest(BINDINGS);
    expect(await loadPack(new MemoryStore(files(m)))).toEqual(m);
  });
});

describe("checking a pack", () => {
  test("says which bindings are stale and what each needs, and writes nothing", async () => {
    const store = new MemoryStore(files());
    const before = hashes(store);
    const report = await checkPack(store);
    expect(report.pack_id).toBe("quarterly");
    expect(report.fresh).toBe(false);
    expect(report.bindings.map((b) => [b.binding_id, b.status])).toEqual(BINDINGS.map((b) => [b.id, "stale"]));
    expect(report.documents.map((d) => d.doc_name)).toEqual(["deck.docx", "deck.pptx"]);
    expect(report.bindings.every((b) => b.ops > 0)).toBe(true);
    expect(hashes(store)).toEqual(before);
  });
});

describe("refreshing a pack", () => {
  test("brings every binding up to date, writes only the target documents, and then reads as fresh", async () => {
    const store = new MemoryStore(files());
    const before = hashes(store);
    const report = await refreshPack(store);
    expect(report.fresh).toBe(true);
    expect(report.bindings.map((b) => b.status)).toEqual(BINDINGS.map(() => "refreshed"));
    expect(report.documents.map((d) => [d.doc_name, d.sha256_before, d.sha256_after])).toEqual([
      ["deck.docx", before["deck.docx"], sha256(bytesFrom(store, "deck.docx"))],
      ["deck.pptx", before["deck.pptx"], sha256(bytesFrom(store, "deck.pptx"))],
    ]);
    const after = hashes(store);
    expect(after["pack.wolf.json"]).toBe(before["pack.wolf.json"]);
    expect(after["fin.xlsx"]).toBe(before["fin.xlsx"]);
    expect(after["deck.docx"]).not.toBe(before["deck.docx"]);
    expect(after["deck.pptx"]).not.toBe(before["deck.pptx"]);

    const word = partText(bytesFrom(store, "deck.docx"), "word/document.xml");
    expect(word).toContain("$1,234,567.89");
    expect(word).toContain("Q3");
    const slide = partText(bytesFrom(store, "deck.pptx"), "ppt/slides/slide1.xml");
    expect(slide).toContain("<a:t>Q1</a:t>");
    expect(slide).toContain("$2,345,678.50");
    expect(partText(bytesFrom(store, "deck.pptx"), "ppt/charts/chart1.xml")).toContain('<c:pt idx="2"><c:v>987654.321</c:v></c:pt>');

    const again = await checkPack(store);
    expect(again.fresh).toBe(true);
    expect(again.bindings.every((b) => b.status === "fresh")).toBe(true);
  });

  test("a second refresh changes no byte", async () => {
    const store = new MemoryStore(files());
    await refreshPack(store);
    const settled = hashes(store);
    const report = await refreshPack(store);
    expect(report.documents).toEqual([]);
    expect(report.bindings.every((b) => b.status === "fresh")).toBe(true);
    expect(hashes(store)).toEqual(settled);
  });

  test("the same inputs give the same bytes on any run", async () => {
    const first = new MemoryStore(files());
    const second = new MemoryStore(files());
    await refreshPack(first);
    await refreshPack(second);
    expect(hashes(first)).toEqual(hashes(second));
  });

  test("a binding's own number format wins over the format of the cell", async () => {
    const m = manifest([binding({ id: "h", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" }, number_format: "#,##0" })]);
    const store = new MemoryStore(files(m));
    await refreshPack(store);
    expect(partText(bytesFrom(store, "deck.docx"), "word/document.xml")).toContain("1,234,568");
  });

  test("the locale of the source decides the separators", async () => {
    const m = manifest(BINDINGS.slice(1, 2), { determinism: { clock: "2026-01-02T03:04:05Z", seed: 7, timezone: "UTC", locale: "de-DE" } });
    const store = new MemoryStore(files(m));
    await refreshPack(store);
    expect(partText(bytesFrom(store, "deck.docx"), "word/document.xml")).toContain("$1.234.567,89");
  });

  test("a recalculated workbook is what is read", async () => {
    const store = new MemoryStore(files(manifest(BINDINGS.slice(1, 2))));
    const evaluator = evaluatorFor(() => xlsx({ rows: [["Quarter", { v: 42, s: STYLE.currency }]], names: { Headline: "Fin!$B$1" } }));
    await refreshPack(store, { evaluator });
    expect(partText(bytesFrom(store, "deck.docx"), "word/document.xml")).toContain("$42.00");
  });

  test("a CSV snapshot feeds a table, and a snapshot that is not the pinned one refuses the pack", async () => {
    const csv = bytesOf("Quarter,Units\nQ1,10\nQ2,20\n");
    const m = manifest(
      [binding({ id: "units", source_id: "csv", target_kind: "docx_table", target_address: "Revenue", selector: { type: "table", name: "units" }, fit_policy: "grow" })],
    );
    m.sources.push({ id: "csv", kind: "csv_snapshot", doc_name: "units.csv", determinism: { clock: "2026-01-02T03:04:05Z", seed: 1, snapshot_sha256: sha256(csv) } });
    const store = new MemoryStore(files(m, [["units.csv", csv]]));
    await refreshPack(store);
    expect(partText(bytesFrom(store, "deck.docx"), "word/document.xml")).toContain(">20<");
    const tampered = new MemoryStore(files(m, [["units.csv", bytesOf("Quarter,Units\nQ1,99\n")]]));
    const error = await refreshPack(tampered).catch((e: unknown) => e);
    expect(error instanceof PackError ? error.problems.map((p) => p.code) : []).toEqual(["snapshot-sha256-mismatch"]);
  });
});

describe("refusing a pack", () => {
  test("refuses all of it when one binding cannot be written, names every such binding, and writes nothing", async () => {
    const bad = [
      ...BINDINGS.slice(2, 3),
      binding({ id: "missing-sheet", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "cell", sheet: "Nope", ref: "A1" } }),
      binding({ id: "no-bookmark", target_kind: "docx_bookmark", target_address: "Absent", selector: { type: "cell", sheet: "Fin", ref: "A1" } }),
    ];
    const store = new MemoryStore(files(manifest(bad)));
    const before = hashes(store);
    const error = await refreshPack(store).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackError);
    if (!(error instanceof PackError)) throw error;
    expect(error.code).toBe("pack-refused");
    expect(error.problems.map((p) => [p.binding_id, p.code])).toEqual([
      ["missing-sheet", "unknown-sheet"],
      ["no-bookmark", "address-unresolved"],
    ]);
    expect(error.problems[1]).toMatchObject({ target_doc: "deck.docx", target_address: "Absent" });
    expect(hashes(store)).toEqual(before);
    expect(await codeOf(() => checkPack(store))).toBe("pack-refused");
  });

  test("a fit policy of fail refuses a table that is too small", async () => {
    const m = manifest([binding({ id: "t", target_kind: "pptx_table", target_address: "slide:@1/shape:Table 1", selector: range("A1:B4"), fit_policy: "fail" })]);
    const store = new MemoryStore(files(m));
    const error = await refreshPack(store).catch((e: unknown) => e);
    expect(error instanceof PackError ? error.problems[0]?.code : undefined).toBe("table-overflow");
  });

  test("a value the selector shapes wrongly, or that is not a number, or cannot be stored, is refused by name", async () => {
    const shapes = manifest([
      binding({ id: "pair", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Pair" } }),
      binding({ id: "words", target_kind: "pptx_chart_series", target_address: "slide:@1/shape:Chart 1/chart/series:Sales", selector: range("A2:A4") }),
      binding({ id: "block", target_kind: "pptx_chart_series", target_address: "slide:@1/shape:Chart 1/chart/series:@1", selector: range("B2:C3") }),
    ]);
    const workbook = xlsx({ rows: QUARTERS, names: { Pair: "Fin!$B$2:$C$2" } });
    const error = await checkPack(new MemoryStore([["pack.wolf.json", manifestBytes(shapes)], ["fin.xlsx", workbook], ["deck.docx", docx()], ["deck.pptx", pptx()]])).catch((e: unknown) => e);
    expect(error instanceof PackError ? error.problems.map((p) => [p.binding_id, p.code]) : []).toEqual([
      ["pair", "selector-shape"],
      ["words", "non-numeric-value"],
      ["block", "selector-shape"],
    ]);
    const control = manifest([binding({ id: "c", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "cell", sheet: "Fin", ref: "A1" } })]);
    const text = xlsx({ rows: [["bell\u0007"]] });
    expect(await codeOf(() => checkPack(new MemoryStore([["pack.wolf.json", manifestBytes(control)], ["fin.xlsx", text], ["deck.docx", docx()]])))).toBe("pack-refused");
  });

  test("a target document outside the pack is never read", async () => {
    const outside = manifest([binding({ id: "x", target_doc: "../elsewhere.docx", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "cell", sheet: "Fin", ref: "A1" } })]);
    const error = await checkPack(new MemoryStore(files(outside))).catch((e: unknown) => e);
    expect(error instanceof PackError ? error.problems.map((p) => p.code) : []).toEqual(["path-outside-pack"]);
  });
});

describe("refreshing through an engine", () => {
  test("replays one batch per document under the determinism of the source, and writes what the engine returns", async () => {
    const engine = new LocalEngine();
    const viaEngine = new MemoryStore(files());
    const local = new MemoryStore(files());
    await refreshPack(viaEngine, { engine });
    await refreshPack(local);
    expect(engine.replays.map((r) => [r.name, r.batches.length])).toEqual([
      ["deck.docx", 1],
      ["deck.pptx", 1],
    ]);
    expect(engine.replays[0]?.batches[0]).toMatchObject({ clock: "2026-01-02T03:04:05Z", timezone: "UTC", label: "pack quarterly: refresh" });
    expect(hashes(viaEngine)).toEqual(hashes(local));
  });

  test("an engine whose result still differs from the sources writes nothing", async () => {
    class Stalled extends LocalEngine {
      override replay(input: ReplayInput): Promise<ReplayResult> {
        return super.replay({ ...input, batches: [] });
      }
    }
    const store = new MemoryStore(files());
    const before = hashes(store);
    expect(await codeOf(() => refreshPack(store, { engine: new Stalled() }))).toBe("refresh-did-not-converge");
    expect(hashes(store)).toEqual(before);
  });
});

describe("a directory pack", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wolfsdk-packs-"));
    for (const [name, bytes] of files()) await writeFile(join(dir, name), bytes);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("is refreshed in place and leaves no staging file behind", async () => {
    const before = await readFile(join(dir, "deck.docx"));
    const report = await refreshPack(new DirectoryStore(dir));
    expect(report.fresh).toBe(true);
    expect(sha256(new Uint8Array(await readFile(join(dir, "deck.docx"))))).not.toBe(sha256(new Uint8Array(before)));
    expect((await readdir(dir)).sort()).toEqual(["deck.docx", "deck.pptx", "fin.xlsx", "pack.wolf.json"]);
    expect((await checkPack(new DirectoryStore(dir))).fresh).toBe(true);
  });

  test("a write that is refused part way leaves every file as it was", async () => {
    const store = new DirectoryStore(dir);
    const before = await readFile(join(dir, "deck.docx"));
    const write = store.writeAll(new Map([["deck.docx", bytesOf("changed")], ["../outside.docx", bytesOf("x")]]));
    expect(await codeOf(() => write)).toBe("path-outside-pack");
    expect(new Uint8Array(await readFile(join(dir, "deck.docx")))).toEqual(new Uint8Array(before));
    expect((await readdir(dir)).sort()).toEqual(["deck.docx", "deck.pptx", "fin.xlsx", "pack.wolf.json"]);
  });
});

describe("refreshing in a room", () => {
  const robot: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
  const alice: RoomActor = { kind: "user", id: "alice", name: "Alice" };
  let dir: string;
  let server: RoomServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wolfsdk-packs-room-"));
    server = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new LocalEngine() });
    expect((await server.createRoom(alice, { room_id: "r1", workspace_id: "ws" })).ok).toBe(true);
    for (const [name, format, bytes] of [["deck.docx", "docx", docx()], ["deck.pptx", "pptx", pptx()]] as const) {
      expect((await server.addDocument("r1", alice, { name, format, bytes })).ok).toBe(true);
    }
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const sources = () => new MemoryStore([["fin.xlsx", WORKBOOK()]]);
  const headOf = async (name: string) => {
    const read = await server.readHead("r1", alice, name);
    if (!read.ok) throw new Error(read.error.message);
    return read.value;
  };

  test("commits one edit per document, and the room ends with the bytes a local refresh writes", async () => {
    const result = await refreshPackInRoom(server, "r1", robot, manifest(BINDINGS), { sources: sources(), mode: "commit" });
    expect(result.report.fresh).toBe(false);
    expect(result.edits.map((e) => [e.doc_name, e.result.ok])).toEqual([["deck.docx", true], ["deck.pptx", true]]);
    const local = new MemoryStore(files());
    await refreshPack(local);
    for (const name of ["deck.docx", "deck.pptx"]) {
      const head = await headOf(name);
      expect(head.head.revision).toBe(1);
      expect(sha256(head.bytes)).toBe(sha256(bytesFrom(local, name)));
    }
    const again = await refreshPackInRoom(server, "r1", robot, manifest(BINDINGS), { sources: sources(), mode: "commit" });
    expect(again.report.fresh).toBe(true);
    expect(again.edits).toEqual([]);
  });

  test("proposes instead when asked: the heads stay where they were", async () => {
    const result = await refreshPackInRoom(server, "r1", robot, manifest(BINDINGS), { sources: sources(), mode: "propose" });
    expect(result.edits.every((e) => e.result.ok && e.result.value.mode === "propose")).toBe(true);
    expect((await headOf("deck.docx")).head.revision).toBe(0);
    expect((await headOf("deck.pptx")).head.revision).toBe(0);
  });

  test("a document someone changed meanwhile is a revision mismatch, and the edits after it are not sent", async () => {
    const edit = server.edit.bind(server);
    let raced = false;
    server.edit = async (roomId, actor, request) => {
      if (!raced) {
        raced = true;
        await edit(roomId, alice, { doc_name: "deck.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "set", target: "table:Revenue/row:@1/cell:@1", value: { text: "Edited" } }] } });
      }
      return edit(roomId, actor, request);
    };
    const result = await refreshPackInRoom(server, "r1", robot, manifest(BINDINGS), { sources: sources(), mode: "commit" });
    expect(result.edits).toHaveLength(1);
    const [first] = result.edits;
    expect(first?.result.ok === false ? first.result.error.code : "committed").toBe("REVISION_MISMATCH");
    expect((await headOf("deck.docx")).head.revision).toBe(1);
    expect((await headOf("deck.pptx")).head.revision).toBe(0);
  });

  test("a document the room does not have is named", async () => {
    const m = manifest([binding({ id: "x", target_doc: "other.docx", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "cell", sheet: "Fin", ref: "A1" } })]);
    const error = await refreshPackInRoom(server, "r1", robot, m, { sources: sources(), mode: "commit" }).catch((e: unknown) => e);
    expect(error instanceof PackError ? error.problems.map((p) => p.code) : []).toEqual(["target-missing"]);
  });
});
