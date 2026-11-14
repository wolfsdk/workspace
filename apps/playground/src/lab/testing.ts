/**
 * Fakes for tests. No engine, no network, no DOM. Modes and helpers test
 * against these; `src/main.tsx` wires the real implementations.
 */
import { createLabBus } from "./bus.ts";
import type {
  AssetRef,
  EngineIdentity,
  EngineStatus,
  Environment,
  Finding,
  Journal,
  LabAssets,
  LabDoc,
  LabEngine,
  LabRivals,
  LabStep,
  LabVerifier,
  MemberInfo,
  MemberVerdict,
  ModeDeps,
  ModeProps,
  Op,
  PackageDelta,
  PackageInfo,
  PageRaster,
  PickedFile,
  RecalcReport,
  RecalcResult,
  Region,
  RivalRecord,
} from "./types.ts";

/** Deterministic 64-hex string that looks like a sha256; not a real digest. */
export const hex = (seed: string): string => {
  let h1 = 0x811c9dc5;
  let out = "";
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < seed.length; i++) h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ round, 0x01000193) >>> 0;
    out += h1.toString(16).padStart(8, "0");
  }
  return out;
};

/** A valid 1x1 transparent PNG. */
export const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]) as Uint8Array<ArrayBuffer>;

export const sampleIdentity: EngineIdentity = {
  version: "0.0.0-fake",
  moduleSha256: hex("module"),
  moduleBytes: 1024,
  url: "https://engine.invalid/v0.0.0-fake/wolf_web.wasm",
};

export const sampleEnvironment: Environment = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 };

const member = (name: string, size: number, offset: number): MemberInfo => ({
  name,
  method: 8,
  crc32: 0,
  compressedSize: size,
  size: size * 3,
  streamSha256: hex(`${name}:${size}`),
  headerOffset: offset,
  dataOffset: offset + 30 + name.length,
});

export const samplePackage: PackageInfo = {
  bytes: 9000,
  sha256: hex("base"),
  members: [
    member("[Content_Types].xml", 400, 0),
    member("xl/workbook.xml", 600, 500),
    member("xl/worksheets/sheet1.xml", 4000, 1200),
    member("xl/styles.xml", 1800, 5300),
    member("xl/sharedStrings.xml", 900, 7200),
  ],
};

export function sampleDelta(changed: string[] = ["xl/worksheets/sheet1.xml"]): PackageDelta {
  const counts: Record<MemberVerdict, number> = {
    "identical-stream": 0,
    "same-bytes-recompressed": 0,
    "xml-equivalent": 0,
    changed: 0,
    removed: 0,
    added: 0,
  };
  let untouched = 0;
  let total = 0;
  const verdicts = samplePackage.members.map((m) => {
    const verdict: MemberVerdict = changed.includes(m.name) ? "changed" : "identical-stream";
    counts[verdict]++;
    total += m.compressedSize;
    if (verdict === "identical-stream") untouched += m.compressedSize;
    return { name: m.name, verdict, bytesBefore: m.compressedSize, bytesAfter: m.compressedSize };
  });
  return { before: samplePackage, after: samplePackage, verdicts, counts, untouchedByteShare: untouched / total };
}

export const sampleRegions: Region[] = [
  { object_id: "sheet:#1/cell:B2", page: 1, bbox_px: [100, 100, 80, 20], bbox_pt: [48, 48, 38.4, 9.6] },
];

/** A picked workbook. The bytes are not a real package; the fake engine does not read them. */
export const sampleFile: PickedFile = {
  name: "sample.xlsx",
  bytes: new TextEncoder().encode("sample workbook bytes") as Uint8Array<ArrayBuffer>,
};

export const sampleFindings: Finding[] = [
  {
    id: "f1",
    kind: "hidden",
    reason: "hidden-row",
    address: "sheet:#1/cell:A9",
    text: "Pay to account 0000",
    chars: 19,
    source: "observe",
  },
  {
    id: "f2",
    kind: "hidden",
    reason: "very-hidden-sheet",
    address: "sheet:#2",
    page: 1,
    bboxPt: [48, 200, 120, 12],
    text: "Adjustments",
    chars: 11,
    source: "observe",
  },
];

export const sampleRecalc: RecalcReport = {
  formulas: 12,
  ms: 3,
  cells: [
    {
      address: "sheet:#1/cell:B6",
      sheet: "Model",
      a1: "B6",
      formula: "=SUM(B2:B5)",
      cached: { number: 9999 },
      computed: { number: 1540 },
    },
  ],
};

/** Assets from a map of logical path to bytes. Unknown ids and paths reject. */
export class FakeAssets implements LabAssets {
  readonly #byId = new Map<string, { ref: AssetRef; bytes: Uint8Array<ArrayBuffer> }>();
  readonly #byPath = new Map<string, AssetRef>();
  readonly requested: string[] = [];

  constructor(files: Record<string, Uint8Array> = {}) {
    for (const [path, bytes] of Object.entries(files)) this.add(path, bytes);
  }

  add(path: string, bytes: Uint8Array, type = "application/octet-stream"): AssetRef {
    const ref: AssetRef = { id: hex(path), path, bytes: bytes.byteLength, type };
    this.#byId.set(ref.id, { ref, bytes: new Uint8Array(bytes) });
    this.#byPath.set(path, ref);
    return ref;
  }

  async get(ref: AssetRef | string): Promise<Uint8Array<ArrayBuffer>> {
    const key = typeof ref === "string" ? ref : ref.id;
    this.requested.push(key);
    const hit = this.#byId.get(key) ?? this.#byId.get(this.#byPath.get(key)?.id ?? "");
    if (hit) return new Uint8Array(hit.bytes);
    throw new Error(`no such asset: ${key}`);
  }

  resolve(path: string): AssetRef | undefined {
    return this.#byPath.get(path);
  }

  list(): readonly AssetRef[] {
    return [...this.#byId.values()].map((entry) => entry.ref);
  }
}

/**
 * In-memory engine. `openFile` returns an xlsx snapshot with no steps;
 * `apply` appends a step with a fake digest. Set `failApply` to make the next
 * apply refuse, and `recalc` to change what `recalcReport` answers for a
 * workbook.
 */
export class FakeLabEngine implements LabEngine {
  identity: EngineIdentity | null = sampleIdentity;
  failApply: { code: string; message: string } | null = null;
  recalc: RecalcResult = { kind: "report", report: sampleRecalc };
  findingsResult: Finding[] = sampleFindings;
  readonly calls: string[] = [];
  readonly #listeners = new Set<() => void>();
  #phase: EngineStatus["phase"] = "ready";
  #disposed = false;
  #nextDoc = 1;

  status(): EngineStatus {
    return { phase: this.#phase, loading: null, error: null };
  }

  async load(): Promise<void> {
    this.calls.push("load");
    if (this.#phase === "ready") return;
    this.#phase = "ready";
    for (const listener of this.#listeners) listener();
  }

  async openFile(bytes: Uint8Array, name: string): Promise<LabDoc> {
    this.#live();
    this.calls.push(`openFile:${name}:${bytes.byteLength}`);
    await this.load();
    return this.#doc(`doc-${this.#nextDoc++}`, name, []);
  }

  async apply(doc: LabDoc, ops: Op[], label: string, author?: string): Promise<LabDoc> {
    this.#live();
    this.calls.push(`apply:${label}`);
    if (this.failApply) throw new Error(this.failApply.message, { cause: this.failApply });
    const step: LabStep = {
      index: doc.steps.length,
      label,
      author,
      ops,
      baseSha256: doc.sha256,
      resultSha256: hex(`${doc.sha256}:${JSON.stringify(ops)}`),
      changes: [],
      partsWritten: ["xl/worksheets/sheet1.xml"],
      delta: sampleDelta(),
      status: "applied",
      ms: 1,
    };
    return this.#doc(doc.id, doc.name, [...doc.steps, step]);
  }

  async pageImage(doc: LabDoc, pageNumber: number, pxPerPt: number): Promise<PageRaster> {
    this.#live();
    this.calls.push(`pageImage:${pageNumber}`);
    const info = doc.pages.find((p) => p.page === pageNumber);
    if (!info) throw new Error("page-unknown", { cause: { code: "page-unknown", message: `no page ${pageNumber}` } });
    return {
      page: pageNumber,
      png: new Uint8Array(PNG_1X1),
      widthPx: Math.round(info.widthPt * pxPerPt),
      heightPx: Math.round(info.heightPt * pxPerPt),
      widthPt: info.widthPt,
      heightPt: info.heightPt,
      regions: doc.regions.filter((r) => r.page === pageNumber),
    };
  }

  async findings(): Promise<Finding[]> {
    this.#live();
    return this.findingsResult;
  }

  async recalcReport(doc: LabDoc): Promise<RecalcResult | null> {
    this.#live();
    this.calls.push("recalcReport");
    return doc.format === "xlsx" ? this.recalc : null;
  }

  async bytes(doc: LabDoc): Promise<Uint8Array<ArrayBuffer>> {
    this.#live();
    return new TextEncoder().encode(doc.sha256) as Uint8Array<ArrayBuffer>;
  }

  journal(doc: LabDoc): Journal {
    return {
      file: { name: doc.name, format: doc.format, sha256: doc.baseSha256 },
      environment: sampleEnvironment,
      engine: this.identity,
      entries: doc.steps.map((s) => ({
        index: s.index,
        label: s.label,
        author: s.author,
        ops: s.ops,
        status: s.status,
        baseSha256: s.baseSha256,
        resultSha256: s.resultSha256,
      })),
      resultSha256: doc.sha256,
    };
  }

  async close(doc: LabDoc): Promise<void> {
    this.calls.push(`close:${doc.id}`);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.calls.push("dispose");
    this.#disposed = true;
    this.#listeners.clear();
  }

  /** Put the engine back to `idle`, as before a first load. */
  unload(): void {
    this.#phase = "idle";
  }

  #live(): void {
    if (this.#disposed) throw new Error("the engine was disposed");
  }

  #doc(id: string, name: string, steps: LabStep[]): LabDoc {
    return {
      id,
      name,
      format: "xlsx",
      sha256: steps.length === 0 ? hex("base") : steps.at(-1)!.resultSha256,
      baseSha256: hex("base"),
      steps,
      pages: [{ page: 1, widthPt: 612, heightPt: 792 }],
      nodes: [],
      regions: sampleRegions,
    };
  }
}

export const fakeVerifier: LabVerifier = {
  async readPackage() {
    return samplePackage;
  },
  async comparePackages() {
    return sampleDelta();
  },
  async sha256Hex(bytes) {
    return hex(String(bytes.byteLength));
  },
};

export function fakeRivals(record?: Partial<RivalRecord>): LabRivals & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    supports: (rival, format) => (rival === "openpyxl") === (format === "xlsx"),
    async run(rival, _bytes, intent) {
      calls.push(`${rival}:${intent.kind}`);
      return {
        rival,
        version: "0.0.0-fake",
        intent,
        ok: true,
        delta: sampleDelta(["xl/worksheets/sheet1.xml", "xl/styles.xml"]),
        losses: [{ category: "styles", members: ["xl/styles.xml"], severity: "rewrite" }],
        ms: 5,
        ...record,
      };
    },
    dispose() {},
  };
}

/** `ModeDeps` with inert components. Override what a test needs. */
export function fakeDeps(overrides: Partial<ModeDeps> = {}): ModeDeps {
  const Nothing = () => null;
  return {
    verifier: fakeVerifier,
    rivals: fakeRivals(),
    AnatomyMap: Nothing,
    ByteRibbon: Nothing,
    Legend: Nothing,
    CodeDrawer: Nothing,
    geiger: { tick() {}, setMuted() {}, muted: true, dispose() {} },
    wolfOpsFor: (intent) =>
      intent.kind === "set-cell" ? [{ op: "set", target: `sheet:${intent.sheet}/cell:${intent.a1}`, value: intent.value }] : [],
    ...overrides,
  };
}

/** Ready-made `ModeProps` on `sampleFile`, opened in a `FakeLabEngine`. */
export async function fakeModeProps(overrides: Partial<ModeProps> = {}): Promise<ModeProps> {
  const engine = overrides.engine ?? new FakeLabEngine();
  const file = overrides.file ?? sampleFile;
  const doc = overrides.doc ?? (await engine.openFile(file.bytes, file.name));
  return {
    engine,
    file,
    doc,
    onDoc() {},
    deps: fakeDeps(),
    bus: createLabBus(),
    ...overrides,
  };
}
