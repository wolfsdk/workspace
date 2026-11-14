/**
 * Reference `EditorHost`: the single store every plugin reads and writes
 * through. Framework-free; `useEditor` in `hooks.ts` binds it to Preact.
 */

import { KernelRequestError } from "@wolfsdk/protocol";
import type {
  Address,
  ApplyResult,
  DocState,
  KernelClient,
  KernelError,
  Op,
  PageImage,
  Region,
  ViewNode,
} from "@wolfsdk/protocol";
import type { ApplyOptions, EditorHost, EditorSnapshot, HistoryEntry } from "./ui.ts";

const EMPTY: EditorSnapshot = {
  state: null,
  selection: [],
  zoom: 1,
  currentPage: 1,
  busy: false,
  history: [],
  lastError: null,
  reveal: null,
};

function toKernelError(cause: unknown): KernelError {
  if (cause instanceof KernelRequestError) return cause.error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: "host-failure", message };
}

export function createEditorHost(kernel: KernelClient): EditorHost {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  let nodeIndex = new Map<Address, ViewNode>();
  let regionIndex = new Map<number, Region[]>();
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  // Page images are valid for one revision of one document.
  let imageKey = "";
  const images = new Map<string, Promise<PageImage>>();
  const urls = new Map<string, Promise<string>>();

  function publish(patch: Partial<EditorSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  }

  function dropImages(): void {
    for (const url of urls.values()) void url.then(URL.revokeObjectURL, () => {});
    images.clear();
    urls.clear();
  }

  function index(state: DocState | null): void {
    nodeIndex = new Map();
    regionIndex = new Map();
    const key = state ? `${state.doc}:${state.sha256}` : "";
    if (key !== imageKey) {
      imageKey = key;
      dropImages();
    }
    if (!state) return;
    for (const node of state.nodes) nodeIndex.set(node.id, node);
    for (const region of state.regions) {
      const list = regionIndex.get(region.page);
      if (list) list.push(region);
      else regionIndex.set(region.page, [region]);
    }
  }

  function setState(state: DocState | null, patch: Partial<EditorSnapshot> = {}): void {
    index(state);
    const pages = state?.pages ?? [];
    const currentPage = pages.some((p) => p.page === snapshot.currentPage)
      ? snapshot.currentPage
      : (pages[0]?.page ?? 1);
    publish({ state, currentPage, ...patch });
  }

  /** Run kernel work in issue order and keep `busy` accurate. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    pending += 1;
    if (!snapshot.busy) publish({ busy: true });
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run.finally(() => {
      pending -= 1;
      if (pending === 0) publish({ busy: false });
    });
  }

  function requireDoc(): DocState {
    if (!snapshot.state) throw new KernelRequestError({ code: "doc-unknown", message: "no document is open" });
    return snapshot.state;
  }

  async function move(step: (state: DocState) => Promise<DocState>): Promise<void> {
    await enqueue(async () => {
      try {
        const next = await step(requireDoc());
        const alive = snapshot.selection.filter((id) => next.nodes.some((n) => n.id === id));
        setState(next, { selection: alive, lastError: null });
      } catch (cause) {
        publish({ lastError: toKernelError(cause) });
      }
    });
  }

  const host: EditorHost = {
    kernel,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    open(bytes, name) {
      return enqueue(async () => {
        const previous = snapshot.state;
        try {
          const state = await kernel.open(bytes, name);
          setState(state, {
            selection: [],
            history: [],
            lastError: null,
            reveal: null,
            currentPage: state.pages[0]?.page ?? 1,
          });
          if (previous) await kernel.close(previous.doc).catch(() => {});
          return state;
        } catch (cause) {
          publish({ lastError: toKernelError(cause) });
          throw cause;
        }
      });
    },

    apply(ops: Op[], options: ApplyOptions = {}): Promise<ApplyResult> {
      return enqueue(async () => {
        const before = requireDoc();
        let result: ApplyResult;
        try {
          result = await kernel.apply(before.doc, ops, options.at);
        } catch (cause) {
          const error = toKernelError(cause);
          result = { ok: false, error, errors: [error], timings: { compileMs: 0, totalMs: 0, runs: [] } };
        }
        if (!result.ok) {
          if (!options.quiet) publish({ lastError: result.error });
          return result;
        }
        const remap = new Map(result.transaction.address_map.map((m) => [m.before, m.after]));
        const present = new Set(result.state.nodes.map((n) => n.id));
        const selection = snapshot.selection.map((id) => remap.get(id) ?? id).filter((id) => present.has(id));
        const entry: HistoryEntry = {
          revision: result.state.revision,
          label: options.label ?? ops.map((op) => op.op).join(", "),
          source: options.source ?? "unknown",
          ops,
          diff: result.diff,
          transaction: result.transaction,
          baseSha256: before.sha256,
          resultSha256: result.state.sha256,
          appliedAt: Date.now(),
        };
        // Applying after an undo drops the redo tail, as the kernel does.
        const history = [...snapshot.history.slice(0, before.revision), entry];
        setState(result.state, { selection, history, lastError: null });
        return result;
      });
    },

    undo: () => move((state) => kernel.undo(state.doc)),
    redo: () => move((state) => kernel.redo(state.doc)),
    goto: (revision) => move((state) => kernel.goto(state.doc, revision)),

    save: () => enqueue(() => kernel.save(requireDoc().doc)),

    close() {
      return enqueue(async () => {
        const state = snapshot.state;
        setState(null, { selection: [], history: [], lastError: null, reveal: null });
        if (state) await kernel.close(state.doc);
      });
    },

    select(ids, options = {}) {
      const next = options.additive ? [...new Set([...snapshot.selection, ...ids])] : [...new Set(ids)];
      const same = next.length === snapshot.selection.length && next.every((id, i) => id === snapshot.selection[i]);
      if (!same) publish({ selection: next });
    },
    setZoom(zoom) {
      const clamped = Math.min(8, Math.max(0.1, zoom));
      if (clamped !== snapshot.zoom) publish({ zoom: clamped });
    },
    setCurrentPage(page) {
      if (page !== snapshot.currentPage) publish({ currentPage: page });
    },
    reveal(target) {
      publish({ reveal: { ...target, seq: (snapshot.reveal?.seq ?? 0) + 1 } });
    },
    clearError() {
      if (snapshot.lastError) publish({ lastError: null });
    },
    reportError(error) {
      publish({ lastError: error });
    },

    node: (id) => nodeIndex.get(id),
    regionsOn: (page) => regionIndex.get(page) ?? [],

    pageImage(page, scale) {
      const state = requireDoc();
      const key = `${page}@${scale}`;
      let image = images.get(key);
      if (!image) {
        const owner = imageKey;
        image = kernel.page(state.doc, page, scale);
        images.set(key, image);
        // A failed render must not poison the cache for this revision.
        image.catch(() => {
          if (imageKey === owner) images.delete(key);
        });
      }
      return image;
    },

    pageImageUrl(page, scale) {
      const key = `${page}@${scale}`;
      let url = urls.get(key);
      if (!url) {
        const owner = imageKey;
        url = host.pageImage(page, scale).then((image) => {
          const made = URL.createObjectURL(new Blob([image.png], { type: "image/png" }));
          // The revision moved on while rendering: nobody will ask for this URL again.
          if (imageKey !== owner) queueMicrotask(() => URL.revokeObjectURL(made));
          return made;
        });
        urls.set(key, url);
        url.catch(() => {
          if (imageKey === owner) urls.delete(key);
        });
      }
      return url;
    },
  };
  return host;
}
