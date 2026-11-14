/**
 * State shared by the X-ray Stage and Rail, which the shell mounts as two
 * separate components. One document is on screen at a time, so one store.
 */
import type { Finding, KernelError, LabDoc, LabEngine, PageRaster } from "../../lab/index.ts";
import { useEffect, useState } from "preact/hooks";
import { bboxCentre, isLocated } from "./model.ts";

export type LoupePoint = { x: number; y: number };

export type XrayState = {
  docId: string | null;
  selectedId: string | null;
  page: number;
  /** Loupe centre, percent of the page. */
  loupe: LoupePoint;
  /** How the loupe got there; keyboard and list moves glide, pointer moves do not. */
  via: "pointer" | "key" | "select";
};

const initial = (docId: string | null, page = 1): XrayState => ({
  docId,
  selectedId: null,
  page,
  loupe: { x: 50, y: 50 },
  via: "select",
});

let state: XrayState = initial(null);
const listeners = new Set<() => void>();

function set(next: XrayState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** State for `doc`; a different document starts fresh. */
export function stateFor(doc: LabDoc): XrayState {
  return state.docId === doc.id ? state : initial(doc.id, doc.pages[0]?.page ?? 1);
}

export const xrayStore = {
  /** Select a finding. A located one moves the loupe to it, on its page. */
  select(doc: LabDoc, finding: Finding): void {
    const current = stateFor(doc);
    if (!isLocated(finding)) {
      set({ ...current, selectedId: finding.id });
      return;
    }
    const info = doc.pages.find((p) => p.page === finding.page);
    set({
      ...current,
      selectedId: finding.id,
      page: finding.page,
      loupe: info ? bboxCentre(finding.bboxPt, info.widthPt, info.heightPt) : current.loupe,
      via: "select",
    });
  },
  moveLoupe(doc: LabDoc, loupe: LoupePoint, via: "pointer" | "key"): void {
    set({ ...stateFor(doc), loupe, via });
  },
  showPage(doc: LabDoc, page: number): void {
    set({ ...stateFor(doc), page, loupe: { x: 50, y: 50 }, via: "select" });
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useXrayState(doc: LabDoc): XrayState {
  const [, rerender] = useState(0);
  useEffect(() => xrayStore.subscribe(() => rerender((n) => n + 1)), []);
  return stateFor(doc);
}

// ---------------------------------------------------------------------------
// Engine results, cached per snapshot (snapshots are immutable)
// ---------------------------------------------------------------------------

export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: KernelError };

export function kernelErrorOf(error: unknown): KernelError {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
      const message = "message" in cause && typeof cause.message === "string" ? cause.message : error.message;
      return { code: cause.code, message };
    }
    return { code: "error", message: error.message };
  }
  return { code: "error", message: String(error) };
}

const findingsCache = new WeakMap<LabDoc, Promise<Finding[]>>();

/** `engine.findings(doc)`, fetched once per snapshot for Stage and Rail. */
export function useFindings(engine: LabEngine, doc: LabDoc): Loaded<Finding[]> {
  const [result, setResult] = useState<{ doc: LabDoc; loaded: Loaded<Finding[]> } | null>(null);
  useEffect(() => {
    let live = true;
    let pending = findingsCache.get(doc);
    if (!pending) {
      pending = engine.findings(doc);
      findingsCache.set(doc, pending);
    }
    pending.then(
      (value) => live && setResult({ doc, loaded: { status: "ready", value } }),
      (error: unknown) => live && setResult({ doc, loaded: { status: "error", error: kernelErrorOf(error) } }),
    );
    return () => {
      live = false;
    };
  }, [engine, doc]);
  return result?.doc === doc ? result.loaded : { status: "loading" };
}

/** Device pixels per point for the page raster. */
const PX_PER_PT = 2;

/** `engine.pageImage`, shown through a blob URL that is revoked on change. */
export function usePageRaster(
  engine: LabEngine,
  doc: LabDoc,
  page: number,
): Loaded<{ raster: PageRaster; url: string }> {
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded<{ raster: PageRaster; url: string }> } | null>(null);
  const key = `${doc.sha256}:${page}`;
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    engine.pageImage(doc, page, PX_PER_PT).then(
      (raster) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([raster.png], { type: "image/png" }));
        setLoaded({ key, value: { status: "ready", value: { raster, url } } });
      },
      (error: unknown) => live && setLoaded({ key, value: { status: "error", error: kernelErrorOf(error) } }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [engine, doc, page, key]);
  return loaded?.key === key ? loaded.value : { status: "loading" };
}
