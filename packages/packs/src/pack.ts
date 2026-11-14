// A pack at work. `planPack` reads every source and target of a manifest and says, as one batch of agent-api ops
// per target document, what must change; a binding whose ops are empty is fresh. `checkPack` is that plan.
// `refreshPack` applies it, then reads its own result again and refuses to write unless every binding is fresh:
// a refresh that is not a fixed point is a bug, not a result. `refreshPackInRoom` sends the same batches to a
// room as edits. Nothing is written when any binding is refused.
import { PACK_MANIFEST_FILE, validatePackManifest } from "@wolfsdk/protocol/workspace";
import type { PackBinding, PackManifest, PackSource, RoomActor, RoomBatch, RoomOp } from "@wolfsdk/protocol/workspace";
import type { DocumentEngine, EditOutcome, Result, RoomService } from "@wolfsdk/server";
import { DocxDocument } from "./docx.ts";
import { PackError, type PackProblem } from "./errors.ts";
import type { XlsxEvaluator } from "./evaluator.ts";
import { sha256Hex } from "./hash.ts";
import { formatValue, type SourceCell } from "./numfmt.ts";
import { PptxDocument } from "./pptx.ts";
import { openSource, type Block, type SourceReader } from "./sources.ts";
import { packPath, type PackReader, type PackStore } from "./store.ts";
import type { Planned } from "./target.ts";
import { XML_INVALID_CHAR } from "./xml.ts";

export type PackOptions = { evaluator?: XlsxEvaluator };
export type RefreshOptions = PackOptions & {
  /** Apply the batches through this engine instead of the built-in applier. */
  engine?: DocumentEngine;
};

export type BindingReport = {
  binding_id: string;
  target_doc: string;
  target_address: string;
  status: "fresh" | "stale" | "refreshed";
  /** How many ops the binding needs (the ops it needed, once refreshed). */
  ops: number;
  notes: string[];
};

export type DocumentReport = { doc_name: string; ops: number };

export type PackReport = { pack_id: string; fresh: boolean; bindings: BindingReport[]; documents: DocumentReport[] };

export type RefreshedDocument = { doc_name: string; ops: number; sha256_before: string; sha256_after: string; batch: RoomBatch };

export type RefreshReport = { pack_id: string; fresh: true; bindings: BindingReport[]; documents: RefreshedDocument[] };

type OpenDocument = { format: "docx"; bytes: Uint8Array; doc: DocxDocument } | { format: "pptx"; bytes: Uint8Array; doc: PptxDocument };

/** One target document that needs ops: its bytes as they are, the batch that brings it up to date, and the
 * built-in way to apply that batch. */
type PlannedDocument = { name: string; format: "docx" | "pptx"; bytes: Uint8Array; batch: RoomBatch; applyLocally(): Uint8Array };

type PackPlan = { report: PackReport; documents: PlannedDocument[] };

/** The manifest of the pack in `store`, validated. */
export async function loadPack(store: PackReader): Promise<PackManifest> {
  const bytes = await store.read(PACK_MANIFEST_FILE);
  if (bytes === undefined) throw new PackError("manifest-missing", `the pack has no ${PACK_MANIFEST_FILE}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PackError("manifest-invalid", `${PACK_MANIFEST_FILE} is not JSON`);
  }
  const problems = validatePackManifest(parsed);
  if (problems.length > 0) {
    throw new PackError("manifest-invalid", `${PACK_MANIFEST_FILE} is not a valid pack: ${problems.join("; ")}`, {}, problems.map((message) => ({ code: "manifest-invalid", message })));
  }
  // `validatePackManifest` found no problem, so the value has the shape of a `PackManifest`.
  return parsed as PackManifest;
}

function single(block: Block, binding: PackBinding): SourceCell {
  const [row] = block;
  const [cell] = row ?? [];
  if (block.length !== 1 || row?.length !== 1 || cell === undefined) {
    throw new PackError("selector-shape", `${binding.target_kind} takes one value, but the selector reads ${block.length} rows of ${block[0]?.length ?? 0} cells`);
  }
  return cell;
}

function numbers(block: Block): number[] {
  if (block.length > 1 && (block[0]?.length ?? 0) > 1) {
    throw new PackError("selector-shape", `a chart series takes one row or one column of numbers, the selector reads ${block.length} rows of ${block[0]?.length ?? 0} cells`);
  }
  return block.flat().map((cell) => {
    if (typeof cell.value !== "number" || !Number.isFinite(cell.value)) throw new PackError("non-numeric-value", `a chart series takes numbers, the source has ${JSON.stringify(cell.value)}`);
    return cell.value;
  });
}

class PackSession {
  private readonly manifest: PackManifest;
  private readonly sources: PackReader;
  private readonly targets: PackReader;
  private readonly options: PackOptions;
  private readonly readers = new Map<string, Promise<SourceReader>>();
  private readonly documents = new Map<string, Promise<OpenDocument>>();

  constructor(manifest: PackManifest, sources: PackReader, targets: PackReader, options: PackOptions) {
    this.manifest = manifest;
    this.sources = sources;
    this.targets = targets;
    this.options = options;
  }

  private reader(source: PackSource): Promise<SourceReader> {
    let reader = this.readers.get(source.id);
    if (reader === undefined) {
      reader = openSource(source, this.sources, this.options.evaluator);
      this.readers.set(source.id, reader);
    }
    return reader;
  }

  private document(name: string, format: "docx" | "pptx"): Promise<OpenDocument> {
    let document = this.documents.get(name);
    if (document === undefined) {
      document = (async (): Promise<OpenDocument> => {
        const bytes = await this.targets.read(name);
        if (bytes === undefined) throw new PackError("target-missing", `the pack has no target document ${name}`);
        return format === "docx" ? { format, bytes, doc: new DocxDocument(bytes, name) } : { format, bytes, doc: new PptxDocument(bytes, name) };
      })();
      this.documents.set(name, document);
    }
    return document;
  }

  private async docx(binding: PackBinding): Promise<DocxDocument> {
    const open = await this.document(binding.target_doc, "docx");
    if (open.format !== "docx") throw new PackError("target-format", `${binding.target_doc} is bound as ${open.format} and as docx`);
    return open.doc;
  }

  private async pptx(binding: PackBinding): Promise<PptxDocument> {
    const open = await this.document(binding.target_doc, "pptx");
    if (open.format !== "pptx") throw new PackError("target-format", `${binding.target_doc} is bound as ${open.format} and as pptx`);
    return open.doc;
  }

  private async plan(binding: PackBinding): Promise<Planned> {
    const source = this.manifest.sources.find((s) => s.id === binding.source_id);
    if (source === undefined) throw new PackError("source-unknown", `the pack has no source ${JSON.stringify(binding.source_id)}`);
    const reader = await this.reader(source);
    const block = reader.select(binding.selector);
    const context = { locale: source.determinism.locale, date1904: reader.date1904 };
    const text = (cell: SourceCell): string => {
      const formatted = formatValue(cell.value, binding.number_format ?? cell.format, context);
      if (XML_INVALID_CHAR.test(formatted)) throw new PackError("invalid-text", `the value ${JSON.stringify(formatted.slice(0, 40))} holds a character XML cannot store`);
      return formatted;
    };
    switch (binding.target_kind) {
      case "docx_table":
        return (await this.docx(binding)).planTable(binding, block.map((row) => row.map(text)));
      case "docx_bookmark":
        return (await this.docx(binding)).planBookmark(binding, text(single(block, binding)));
      case "pptx_table":
        return (await this.pptx(binding)).planTable(binding, block.map((row) => row.map(text)));
      case "pptx_fit_headline":
        return (await this.pptx(binding)).planHeadline(binding, text(single(block, binding)));
      case "pptx_chart_series":
        return (await this.pptx(binding)).planChartSeries(binding, numbers(block));
    }
  }

  async planAll(): Promise<PackPlan> {
    const problems: PackProblem[] = [];
    const bindings: BindingReport[] = [];
    const opsByDocument = new Map<string, { binding: PackBinding; ops: RoomOp[] }>();
    for (const binding of this.manifest.bindings) {
      try {
        const planned = await this.plan(binding);
        bindings.push({
          binding_id: binding.id,
          target_doc: binding.target_doc,
          target_address: binding.target_address,
          status: planned.ops.length === 0 ? "fresh" : "stale",
          ops: planned.ops.length,
          notes: planned.notes,
        });
        const entry = opsByDocument.get(binding.target_doc) ?? { binding, ops: [] };
        entry.ops.push(...planned.ops);
        opsByDocument.set(binding.target_doc, entry);
      } catch (e) {
        if (!(e instanceof PackError)) throw e;
        problems.push(e.forBinding(binding).toProblem());
      }
    }
    const [first] = problems;
    if (first !== undefined) {
      throw new PackError("pack-refused", `${problems.length} of ${this.manifest.bindings.length} bindings cannot be brought up to date and nothing was written; first: ${first.binding_id}: ${first.code}: ${first.message}`, {}, problems);
    }
    const documents: PlannedDocument[] = [];
    for (const [name, { binding, ops }] of opsByDocument) {
      if (ops.length === 0) continue;
      const open = await this.document(name, binding.target_format);
      // A batch runs under the determinism of the first binding that wrote to its document.
      const determinism = this.manifest.sources.find((s) => s.id === binding.source_id)?.determinism;
      const batch: RoomBatch = { ops, label: `pack ${this.manifest.pack_id}: refresh`, clock: determinism?.clock };
      if (determinism?.timezone !== undefined) batch.timezone = determinism.timezone;
      documents.push({
        name,
        format: open.format,
        bytes: open.bytes,
        batch,
        applyLocally: () => {
          open.doc.apply(ops);
          return open.doc.save();
        },
      });
    }
    return {
      report: {
        pack_id: this.manifest.pack_id,
        fresh: documents.length === 0,
        bindings,
        documents: documents.map((d) => ({ doc_name: d.name, ops: d.batch.ops.length })),
      },
      documents,
    };
  }
}

/** Plan `manifest` over sources read from `sources` and target documents read from `targets`. */
export function planPack(manifest: PackManifest, sources: PackReader, targets: PackReader, options: PackOptions = {}): Promise<PackPlan> {
  return new PackSession(manifest, sources, targets, options).planAll();
}

/** Whether every binding of the pack in `store` is fresh, and what each stale one needs. Writes nothing. */
export async function checkPack(store: PackReader, options: PackOptions = {}): Promise<PackReport> {
  const manifest = await loadPack(store);
  return (await planPack(manifest, store, store, options)).report;
}

/** Bring every binding of the pack in `store` up to date, in one write of the changed documents. */
export async function refreshPack(store: PackStore, options: RefreshOptions = {}): Promise<RefreshReport> {
  const manifest = await loadPack(store);
  const plan = await planPack(manifest, store, store, options);
  const changed = new Map<string, Uint8Array>();
  for (const document of plan.documents) {
    if (options.engine === undefined) {
      changed.set(packPath(document.name), document.applyLocally());
      continue;
    }
    const replayed = await options.engine.replay({ format: document.format, name: document.name, bytes: document.bytes, batches: [document.batch], save: true, pages: false });
    if (replayed.bytes === null) throw new PackError("engine-no-bytes", `the engine returned no bytes for ${document.name}`);
    changed.set(packPath(document.name), replayed.bytes);
  }
  const refreshed: PackReader = { read: async (name) => changed.get(packPath(name)) ?? store.read(name) };
  const verified = await planPack(manifest, store, refreshed, options);
  if (!verified.report.fresh) {
    const stale = verified.report.bindings.filter((b) => b.status === "stale").map((b) => b.binding_id);
    throw new PackError("refresh-did-not-converge", `the refreshed documents still differ from the sources at ${stale.join(", ")}; nothing was written`);
  }
  await store.writeAll(changed);
  return {
    pack_id: manifest.pack_id,
    fresh: true,
    bindings: plan.report.bindings.map((b) => (b.status === "stale" ? { ...b, status: "refreshed" } : b)),
    documents: plan.documents.map((d) => ({
      doc_name: d.name,
      ops: d.batch.ops.length,
      sha256_before: sha256Hex(d.bytes),
      sha256_after: sha256Hex(changed.get(packPath(d.name)) ?? d.bytes),
      batch: d.batch,
    })),
  };
}

export type RoomRefreshOptions = PackOptions & {
  /** Where the sources of the pack are read from (its targets are read from the room). */
  sources: PackReader;
  /** `commit` changes the documents at once; `propose` holds each batch as a proposal for a person to decide. */
  mode: "commit" | "propose";
};

export type RoomRefreshReport = {
  report: PackReport;
  /** One entry per target document that needed ops, in order; the first failure ends the list. */
  edits: { doc_name: string; result: Result<EditOutcome> }[];
};

/** The documents of a room as a pack reader, remembering the revision each was read at. */
class RoomTargets implements PackReader {
  readonly revisions = new Map<string, number>();
  private readonly service: RoomService;
  private readonly roomId: string;
  private readonly actor: RoomActor;

  constructor(service: RoomService, roomId: string, actor: RoomActor) {
    this.service = service;
    this.roomId = roomId;
    this.actor = actor;
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    const read = await this.service.readHead(this.roomId, this.actor, name);
    if (read.ok) {
      this.revisions.set(name, read.value.head.revision);
      return read.value.bytes;
    }
    if (read.error.code === "UNKNOWN_DOCUMENT") return undefined;
    throw new PackError("room-read-failed", `${name}: ${read.error.code}: ${read.error.message}`);
  }
}

/** Send the batches that bring the documents of a room up to date with the pack's sources, as `actor`. Each batch is
 * written against the revision its document was read at, so a document someone else changed meanwhile is a
 * `REVISION_MISMATCH` and nothing of it is applied. */
export async function refreshPackInRoom(service: RoomService, roomId: string, actor: RoomActor, manifest: PackManifest, options: RoomRefreshOptions): Promise<RoomRefreshReport> {
  const targets = new RoomTargets(service, roomId, actor);
  const plan = await planPack(manifest, options.sources, targets, options);
  const edits: RoomRefreshReport["edits"] = [];
  for (const document of plan.documents) {
    const revision = targets.revisions.get(document.name);
    if (revision === undefined) throw new PackError("room-read-failed", `no revision was read for ${document.name}`);
    const result = await service.edit(roomId, actor, { doc_name: document.name, base_revision: revision, mode: options.mode, batch: document.batch });
    edits.push({ doc_name: document.name, result });
    if (!result.ok) break;
  }
  return { report: plan.report, edits };
}
