import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Address, KernelError, PageInfo, Region } from "@wolfsdk/protocol";
import type { EditorHost, EditorPlugin, EditorSnapshot, RevealTarget } from "../host/index.ts";
import {
  INITIAL_ZOOM_CAP,
  PAGE_PAD,
  clampZoom,
  fitPageZoom,
  fitWidthZoom,
  layoutPages,
  pageIndexAt,
  pickScale,
  type FitMode,
  type PageLayout,
} from "./layout.ts";
import { RegionLayer } from "./RegionLayer.tsx";
import { toKernelError } from "./util.ts";
import { renderPage } from "@wolfsdk/runtime/vector";
import { fallbackReason, revisionKey, type VectorDoc, type VectorPage, type VectorPages } from "./vector.ts";

/** A page drawn for the current revision: an engine PNG render (not served from the
 * open/apply cache), or a vector page whose display list was fetched and painted. */
export type RenderInfo = { page: number; ms: number; dpi: number; kind: "png" | "vector" };

type Props = {
  host: EditorHost;
  /** Vector pages of a reactor kernel; null draws engine PNGs. */
  vector: VectorPages | null;
  snapshot: EditorSnapshot;
  /** Active plugins that draw a `PageOverlay`, in plugin order. */
  overlays: EditorPlugin[];
  fitMode: FitMode;
  onFitModeChange: (mode: FitMode) => void;
  onRender: (info: RenderInfo) => void;
  /** A page image became visible (its first decoded image, or a newer one). */
  onShown?: (page: number) => void;
};

/** Computes the scroll position that keeps a remembered point in place under a new layout. */
type ScrollTarget = (layout: PageLayout) => { top: number; left: number };

/** Keep the point at content (x, y) of `old` under viewport offset (px, py) after a re-layout. */
function anchorAt(old: PageLayout, x: number, y: number, px: number, py: number): ScrollTarget {
  const i = Math.max(0, pageIndexAt(old, y));
  if (!old.tops.length) return () => ({ top: 0, left: 0 });
  const ptX = (x - old.lefts[i]!) / old.zoom;
  const ptY = (y - old.tops[i]!) / old.zoom;
  return (l) => ({ top: l.tops[i]! + ptY * l.zoom - py, left: l.lefts[i]! + ptX * l.zoom - px });
}

/** How far beyond the viewport (in viewport heights) pages load images and overlays. */
const OVERSCAN = 1;
/** Wait for zoom to settle before asking for sharper renders. */
const RENDER_DEBOUNCE_MS = 180;

export function PageScroller({ host, vector, snapshot, overlays, fitMode, onFitModeChange, onRender, onShown }: Props) {
  const state = snapshot.state!;
  const { zoom, selection, currentPage, reveal } = snapshot;
  const pages = state.pages;
  const rev = revisionKey(state);
  const stateKey = `${state.doc}:${rev}`;
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 0, height: 0, top: 0, left: 0 });
  const layout = useMemo(() => layoutPages(pages, zoom, view.width), [pages, zoom, view.width]);
  const vdoc = useMemo(() => vector?.forDoc(state.doc) ?? null, [vector, state.doc]);
  const dpr = useDevicePixelRatio();

  const committed = useRef<{ doc: string; zoom: number } | null>(null);
  const pendingScroll = useRef<ScrollTarget | null>(null);
  const reportedPage = useRef<number | null>(null);
  const localSelection = useRef("");
  const openedDoc = useRef<string | null>(null);
  const latest = useRef({ pages, layout, view });
  latest.current = { pages, layout, view };

  // Viewport size.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () =>
      setView((v) =>
        v.width === el.clientWidth && v.height === el.clientHeight
          ? v
          : { width: el.clientWidth, height: el.clientHeight, top: el.scrollTop, left: el.scrollLeft },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A newly opened document starts at the top, fitted to the width (capped).
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!view.width || openedDoc.current === state.doc) return;
    openedDoc.current = state.doc;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    if (fitMode) return;
    const next = clampZoom(Math.min(fitWidthZoom(pages, view.width), INITIAL_ZOOM_CAP));
    if (Math.abs(next - zoom) < 1e-4) return;
    pendingScroll.current = (l) => ({ top: 0, left: Math.max(0, (l.contentWidth - el.clientWidth) / 2) });
    host.setZoom(next);
  }, [state.doc, view.width]);

  // Keep the reading position across zoom changes: the pointer position for
  // Ctrl/Cmd+wheel, otherwise the viewport centre.
  useLayoutEffect(() => {
    const el = ref.current!;
    const prev = committed.current;
    committed.current = { doc: state.doc, zoom };
    if (!prev || prev.doc !== state.doc || prev.zoom === zoom) return;
    const target =
      pendingScroll.current ??
      anchorAt(
        layoutPages(pages, prev.zoom, el.clientWidth),
        el.scrollLeft + el.clientWidth / 2,
        el.scrollTop + el.clientHeight / 2,
        el.clientWidth / 2,
        el.clientHeight / 2,
      );
    pendingScroll.current = null;
    const { top, left } = target(layout);
    el.scrollTop = Math.max(0, top);
    el.scrollLeft = Math.max(0, left);
    setView((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
  }, [zoom, state.doc]);

  // Fit modes follow the viewport size.
  useEffect(() => {
    if (!fitMode || !view.width) return;
    const el = ref.current!;
    const index = Math.max(
      0,
      pages.findIndex((p) => p.page === host.getSnapshot().currentPage),
    );
    const next =
      fitMode === "width" ? fitWidthZoom(pages, view.width) : fitPageZoom(pages[index], view.width, view.height);
    const toPage: ScrollTarget = (l) => ({
      top: (l.tops[index] ?? PAGE_PAD) - PAGE_PAD,
      left: Math.max(0, (l.contentWidth - el.clientWidth) / 2),
    });
    if (Math.abs(next - host.getSnapshot().zoom) < 1e-4) {
      if (fitMode === "page") el.scrollTop = toPage(latest.current.layout).top;
      return;
    }
    if (fitMode === "page") pendingScroll.current = toPage;
    host.setZoom(next);
  }, [fitMode, view.width, view.height, pages]);

  // Ctrl/Cmd+wheel (and trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const current = host.getSnapshot().zoom;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      const next = clampZoom(current * Math.exp(-event.deltaY * unit * 0.002));
      if (Math.abs(next - current) < 1e-4) return;
      // Several wheel events can arrive before the next render: keep the burst's
      // first anchor, whose point was measured against the committed layout.
      if (!pendingScroll.current) {
        const old = layoutPages(latest.current.pages, current, el.clientWidth);
        pendingScroll.current = anchorAt(old, el.scrollLeft + px, el.scrollTop + py, px, py);
      }
      onFitModeChange(null);
      host.setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [host, onFitModeChange]);

  // Scrolling updates `currentPage` (the page under the viewport centre).
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  function onScroll() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = ref.current;
      if (!el) return;
      setView((v) =>
        v.top === el.scrollTop && v.left === el.scrollLeft ? v : { ...v, top: el.scrollTop, left: el.scrollLeft },
      );
      const { layout: l, pages: ps } = latest.current;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const index = atEnd ? ps.length - 1 : pageIndexAt(l, el.scrollTop + el.clientHeight / 2);
      const page = ps[index]?.page;
      if (page === undefined || page === host.getSnapshot().currentPage) return;
      reportedPage.current = page;
      host.setCurrentPage(page);
    });
  }

  /**
   * The single "bring into view" path, used by `host.reveal`, by `currentPage`
   * set elsewhere, and by selections made outside the page (Inspector, plugins).
   * A page is scrolled to its top when its top edge is off-screen. An address
   * uses its first region (or its nearest drawn ancestor's) and centres it when
   * any part is off-screen. Never touches the selection; the resulting scroll
   * updates `currentPage` through `onScroll` like any other scroll.
   */
  function bringIntoView(target: RevealTarget): void {
    const el = ref.current;
    if (!el) return;
    const { layout: l, pages: ps } = latest.current;
    if ("page" in target) {
      const index = ps.findIndex((p) => p.page === target.page);
      if (index < 0) return;
      const top = l.tops[index]! - PAGE_PAD / 2;
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - PAGE_PAD) el.scrollTop = Math.max(0, top);
      return;
    }
    let id: Address | null | undefined = target.address;
    let region: Region | undefined;
    // Nodes without a region of their own (runs in PPTX shapes) use their nearest drawn ancestor.
    while (id && !(region = firstRegion.get(id))) id = host.node(id)?.parent;
    if (!region) return;
    const index = ps.findIndex((p) => p.page === region.page);
    if (index < 0) return;
    const [x, y, w, h] = region.bbox_pt;
    const margin = Math.min(80, el.clientHeight / 4);
    const centre = (start: number, size: number, scroll: number, viewport: number): number | null => {
      if (start >= scroll && start + size <= scroll + viewport) return null;
      return Math.max(0, size > viewport - 2 * margin ? start - margin : start + size / 2 - viewport / 2);
    };
    const top = centre(l.tops[index]! + y * l.zoom, h * l.zoom, el.scrollTop, el.clientHeight);
    const left = centre(l.lefts[index]! + x * l.zoom, w * l.zoom, el.scrollLeft, el.clientWidth);
    if (top !== null) el.scrollTop = top;
    if (left !== null) el.scrollLeft = left;
  }

  // `currentPage` set from elsewhere (a thumbnail rail, the status bar) scrolls to that page.
  useLayoutEffect(() => {
    if (reportedPage.current === currentPage) return;
    reportedPage.current = currentPage;
    bringIntoView({ page: currentPage });
  }, [currentPage]);

  const firstRegion = useMemo(() => {
    const map = new Map<Address, Region>();
    for (const region of state.regions) if (!map.has(region.object_id)) map.set(region.object_id, region);
    return map;
  }, [state]);

  // `host.reveal(...)`: act once per `seq`. The host resets `reveal` to null on open and close.
  const revealSeq = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!reveal) {
      revealSeq.current = null;
      return;
    }
    if (reveal.seq === revealSeq.current) return;
    revealSeq.current = reveal.seq;
    bringIntoView(reveal);
  }, [reveal, firstRegion]);

  // A selection made outside the page (a plugin) brings its first region into view.
  useEffect(() => {
    const key = selection.join("\n");
    if (key === localSelection.current) return;
    localSelection.current = key;
    if (selection[0]) bringIntoView({ address: selection[0] });
  }, [selection, firstRegion]);

  function selectFromLayer(next: Address[]) {
    localSelection.current = next.join("\n");
    host.select(next);
  }

  // Sharper renders are requested only once zoom stops changing; until then
  // the current image is stretched.
  const [renderZoom, setRenderZoom] = useState(zoom);
  useEffect(() => {
    if (renderZoom === zoom) return;
    const timer = setTimeout(() => setRenderZoom(zoom), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [zoom, renderZoom]);
  const viewport = useMemo(() => ({ ...view }), [view.top, view.left, view.width, view.height]);

  const first = Math.max(0, pageIndexAt(layout, view.top - OVERSCAN * view.height));
  const last = pageIndexAt(layout, view.top + (1 + OVERSCAN) * view.height);

  return (
    <div class="we-shell-scroller" data-testid="shell-scroller" ref={ref} onScroll={onScroll}>
      {pages.length === 0 ? (
        <div class="we-shell-no-pages" data-testid="shell-no-pages">
          This revision rendered no pages (for example, a workbook whose sheets print nothing).
        </div>
      ) : (
        <div class="we-shell-pages" style={{ width: `${layout.contentWidth}px`, height: `${layout.contentHeight}px` }}>
          {pages.map((info, index) => (
            <PageBox
              key={info.page}
              host={host}
              vdoc={vdoc}
              info={info}
              top={layout.tops[index]!}
              left={layout.lefts[index]!}
              width={layout.widths[index]!}
              height={layout.heights[index]!}
              near={index >= first && index <= last}
              zoom={zoom}
              dpr={dpr}
              view={viewport}
              scale={pickScale(info, renderZoom * dpr)}
              stateKey={stateKey}
              rev={rev}
              selection={selection}
              onSelect={selectFromLayer}
              overlays={overlays}
              onRender={onRender}
              onShown={onShown}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Scroller viewport in content pixels. */
type Viewport = { top: number; left: number; width: number; height: number };

type PageBoxProps = {
  host: EditorHost;
  vdoc: VectorDoc | null;
  info: PageInfo;
  top: number;
  left: number;
  width: number;
  height: number;
  near: boolean;
  zoom: number;
  dpr: number;
  view: Viewport;
  scale: number;
  stateKey: string;
  /** `revisionKey` of the current revision. */
  rev: string;
  selection: Address[];
  onSelect: (next: Address[]) => void;
  overlays: EditorPlugin[];
  onRender: (info: RenderInfo) => void;
  onShown?: (page: number) => void;
};

function PageBox(props: PageBoxProps) {
  const { host, vdoc, info, near, zoom, width, height } = props;
  return (
    <div
      class="we-shell-page"
      data-testid={`shell-page-${info.page}`}
      data-page={info.page}
      aria-label={`Page ${info.page}`}
      style={{ top: `${props.top}px`, left: `${props.left}px`, width: `${width}px`, height: `${height}px` }}
    >
      {near && (
        <>
          {vdoc ? (
            <PageCanvas
              host={host}
              vdoc={vdoc}
              page={info.page}
              box={{ top: props.top, left: props.left, width, height }}
              view={props.view}
              zoom={zoom}
              dpr={props.dpr}
              scale={props.scale}
              stateKey={props.stateKey}
              rev={props.rev}
              onRender={props.onRender}
              onShown={props.onShown}
            />
          ) : (
            <PageImg
              host={host}
              page={info.page}
              scale={props.scale}
              stateKey={props.stateKey}
              onRender={props.onRender}
              onShown={props.onShown}
            />
          )}
          <RegionLayer
            host={host}
            page={info.page}
            zoom={zoom}
            stateKey={props.stateKey}
            selection={props.selection}
            onSelect={props.onSelect}
          />
          {props.overlays.map((plugin) => {
            const Overlay = plugin.PageOverlay!;
            return (
              <div key={plugin.id} class="we-shell-overlay" data-testid={`shell-overlay-${plugin.id}-${info.page}`}>
                <Overlay host={host} page={info.page} pxPerPt={zoom} widthPx={width} heightPx={height} />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/** Device pixel ratio, updated when the window moves to another screen or the browser zooms. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => globalThis.devicePixelRatio || 1);
  useEffect(() => {
    const update = () => setDpr(globalThis.devicePixelRatio || 1);
    // Browser zoom and moving to another screen also resize the window; some
    // embedders (device emulation) change the ratio without a media change event.
    globalThis.addEventListener?.("resize", update);
    const query = typeof matchMedia === "function" ? matchMedia(`(resolution: ${dpr}dppx)`) : null;
    query?.addEventListener("change", update);
    return () => {
      globalThis.removeEventListener?.("resize", update);
      query?.removeEventListener("change", update);
    };
  }, [dpr]);
  return dpr;
}

/** Largest backing store painted for a whole page (32 MiB of pixels); beyond it only the visible part is painted. */
const MAX_PAGE_PIXELS = 8 * 2 ** 20;
/** CSS pixels painted beyond the viewport around a partially painted page. */
const TILE_MARGIN = 256;

type Rect = { x: number; y: number; w: number; h: number };

type PageCanvasProps = {
  host: EditorHost;
  vdoc: VectorDoc;
  page: number;
  /** Page box in content pixels. */
  box: Viewport;
  view: Viewport;
  zoom: number;
  dpr: number;
  /** PNG scale, for a page that falls back. */
  scale: number;
  stateKey: string;
  rev: string;
  onRender: (info: RenderInfo) => void;
  onShown?: (page: number) => void;
};

/**
 * A vector page (`@wolfsdk/runtime/vector`). The display list is fetched per
 * revision (its source tags and table indices belong to that revision), but a
 * page whose hash is unchanged after an edit, an undo or a redo is not
 * repainted: the canvas keeps its pixels and only the held list is swapped.
 * Zoom, device pixel ratio and scrolling repaint from the held list (about 1
 * to 3 ms) at the exact device scale; the bitmap is never stretched. A page
 * whose backing store would exceed `MAX_PAGE_PIXELS` paints only the visible
 * part plus a margin. A page the renderer cannot draw faithfully (see
 * `fallbackReason`) shows the engine's PNG instead, for as long as its hash lives.
 */
function PageCanvas(props: PageCanvasProps) {
  const { vdoc, page, stateKey, rev, zoom, dpr, view, box } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<VectorPage | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [error, setError] = useState<KernelError | null>(null);
  const [painted, setPainted] = useState(false);
  /** What the canvas holds now. */
  const drawn = useRef<{ page: VectorPage; pxPerPt: number; tile: Rect } | null>(null);
  /** A freshly loaded list whose first paint reports `onRender`. */
  const fresh = useRef<VectorPage | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    let live = true;
    vdoc
      .hashes(rev)
      .then((hashes) => {
        const hash = hashes[page - 1];
        if (!hash)
          throw { code: "page-unknown", message: `page ${page} is not in the laid-out document` } satisfies KernelError;
        if (!live) return;
        const reason = vdoc.fallbacks.get(hash);
        if (reason) {
          setFallback(reason);
          return;
        }
        return vdoc.page(page, rev).then((loaded) => {
          if (!live) return;
          setError(null);
          setFallback(vdoc.fallbacks.get(loaded.hash) ?? null);
          const held = drawn.current;
          if (held && held.page.hash === loaded.hash) {
            // Same drawing as on screen: adopt this revision's list without repainting.
            held.page = loaded;
            callbacks.current.onShown?.(page);
          } else {
            fresh.current = loaded;
          }
          setShown(loaded);
        });
      })
      .catch((cause) => {
        if (!live || vdoc.disposed) return;
        setError(toKernelError(cause));
        callbacks.current.onShown?.(page);
      });
    return () => {
      live = false;
    };
  }, [vdoc, page, stateKey]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || !canvas || fallback) return;
    const pxPerPt = zoom * dpr;
    const fullW = Math.round(shown.dl.width * pxPerPt);
    const fullH = Math.round(shown.dl.height * pxPerPt);
    const css = { w: box.width, h: box.height };
    let tile: Rect = { x: 0, y: 0, w: css.w, h: css.h };
    if (fullW * fullH > MAX_PAGE_PIXELS) {
      const x0 = Math.max(0, view.left - box.left);
      const y0 = Math.max(0, view.top - box.top);
      const x1 = Math.min(css.w, view.left + view.width - box.left);
      const y1 = Math.min(css.h, view.top + view.height - box.top);
      if (x1 <= x0 || y1 <= y0) return; // off screen: paint when scrolled into view
      const held = drawn.current;
      if (
        held &&
        held.page === shown &&
        held.pxPerPt === pxPerPt &&
        held.tile.x <= x0 &&
        held.tile.y <= y0 &&
        held.tile.x + held.tile.w >= x1 &&
        held.tile.y + held.tile.h >= y1
      )
        return;
      const tx = Math.max(0, Math.floor(x0 - TILE_MARGIN));
      const ty = Math.max(0, Math.floor(y0 - TILE_MARGIN));
      tile = {
        x: tx,
        y: ty,
        w: Math.min(css.w, Math.ceil(x1 + TILE_MARGIN)) - tx,
        h: Math.min(css.h, Math.ceil(y1 + TILE_MARGIN)) - ty,
      };
    } else {
      const held = drawn.current;
      if (held && held.page === shown && held.pxPerPt === pxPerPt && held.tile.w === css.w && held.tile.h === css.h)
        return;
    }
    canvas.width = Math.max(1, Math.round(tile.w * dpr));
    canvas.height = Math.max(1, Math.round(tile.h * dpr));
    canvas.style.left = `${tile.x}px`;
    canvas.style.top = `${tile.y}px`;
    canvas.style.width = `${tile.w}px`;
    canvas.style.height = `${tile.h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const stats = renderPage(ctx, shown.dl, {
      pxPerPt,
      resources: vdoc.cache,
      background: "#ffffff",
      offsetX: -tile.x * dpr,
      offsetY: -tile.y * dpr,
    });
    drawn.current = { page: shown, pxPerPt, tile };
    const reason = fallbackReason(shown.dl, stats);
    if (reason) {
      vdoc.fallbacks.set(shown.hash, reason);
      drawn.current = null;
      setFallback(reason);
      return;
    }
    if (fresh.current === shown) {
      fresh.current = null;
      callbacks.current.onRender({ page, ms: shown.loadMs + stats.ms, dpi: Math.round(pxPerPt * 72), kind: "vector" });
    }
    if (!painted) setPainted(true);
    callbacks.current.onShown?.(page);
  }, [shown, fallback, zoom, dpr, view, box.top, box.left, box.width, box.height]);

  if (fallback) {
    return (
      <>
        <PageImg
          host={props.host}
          page={page}
          scale={props.scale}
          stateKey={stateKey}
          onRender={props.onRender}
          onShown={props.onShown}
        />
        <span hidden data-testid={`shell-page-fallback-${page}`}>
          {fallback}
        </span>
      </>
    );
  }
  return (
    <>
      {!painted && !error && (
        <div class="we-shell-page-skeleton" data-testid={`shell-page-skeleton-${page}`} aria-hidden="true" />
      )}
      <canvas
        ref={canvasRef}
        class={painted ? "we-shell-page-canvas" : "we-shell-page-canvas we-shell-page-canvas-pending"}
        data-testid={`shell-page-canvas-${page}`}
        data-page-hash={shown?.hash}
        role="img"
        aria-label={`Page ${page}`}
      />
      {error && (
        <div class="we-shell-page-error" data-testid={`shell-page-error-${page}`}>
          <strong>{error.code}</strong> {error.message}
        </div>
      )}
    </>
  );
}

type PageImgProps = {
  host: EditorHost;
  page: number;
  scale: number;
  stateKey: string;
  onRender: (info: RenderInfo) => void;
  onShown?: (page: number) => void;
};

/**
 * The page image. A new revision's (or zoom's) image loads in a hidden
 * `<img>` stacked above the visible one and replaces it only once decoded,
 * so an edit never flashes white. The old element keeps its decoded pixels
 * even after the host revokes its object URL.
 */
function PageImg({ host, page, scale, stateKey, onRender, onShown }: PageImgProps) {
  const [shown, setShown] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<KernelError | null>(null);

  useEffect(() => {
    let live = true;
    host.pageImage(page, scale).then(
      (image) => {
        if (live && image.source === "render")
          onRender({ page, ms: image.timings.totalMs, dpi: image.dpi, kind: "png" });
      },
      () => {},
    );
    host.pageImageUrl(page, scale).then(
      (url) => {
        if (!live) return;
        setError(null);
        setNext(url);
      },
      (cause) => {
        if (!live) return;
        setError(toKernelError(cause));
        // The page is settled (it shows its error): end any "rendering the first page" stage.
        onShown?.(page);
      },
    );
    return () => {
      live = false;
    };
  }, [host, page, scale, stateKey]);

  const urls = [shown, next].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);
  return (
    <>
      {!shown && !error && (
        <div class="we-shell-page-skeleton" data-testid={`shell-page-skeleton-${page}`} aria-hidden="true" />
      )}
      {urls.map((url) =>
        url === shown ? (
          <img
            key={url}
            src={url}
            class="we-shell-page-img"
            data-testid={`shell-page-img-${page}`}
            alt={`Page ${page}`}
            draggable={false}
          />
        ) : (
          <img
            key={url}
            src={url}
            class="we-shell-page-img we-shell-page-img-pending"
            data-testid={`shell-page-img-pending-${page}`}
            alt=""
            draggable={false}
            onLoad={() => {
              setShown(url);
              onShown?.(page);
            }}
            onError={() => {
              // Superseded before it loaded (the host revoked it): the next effect brings a fresh URL.
              if (next === url) setNext(null);
            }}
          />
        ),
      )}
      {error && (
        <div class="we-shell-page-error" data-testid={`shell-page-error-${page}`}>
          <strong>{error.code}</strong> {error.message}
        </div>
      )}
    </>
  );
}
