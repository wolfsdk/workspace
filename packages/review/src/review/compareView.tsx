import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useEditor, type EditorHost, type PageOverlayProps, type PluginProps } from "../host/index.ts";
import { compareStore, type BeforePage, type CompareStore } from "./compare.ts";
import { useReview } from "./hooks.ts";
import "./compare.css";

const STEP = 0.05;
const MAX_SCALE = 3;

/** The per-host compare store, re-rendering the caller on every change. */
export function useCompare(host: EditorHost): CompareStore {
  const store = compareStore(host);
  const [, setVersion] = useState(store.version);
  useEffect(() => {
    setVersion(store.version);
    return store.subscribe(() => setVersion(store.version));
  }, [store]);
  return store;
}

/** "Compare with before" switch plus the comparison status. */
export function CompareToggle({ host }: PluginProps) {
  const compare = useCompare(host);
  const note = compare.status === "loading" || compare.status === "unavailable" ? compare.reason : "";
  return (
    <div class="we-compare-toggle" data-testid="review-compare-toggle" data-status={compare.status}>
      <label class="we-compare-switch">
        <input
          type="checkbox"
          role="switch"
          checked={compare.enabled}
          aria-checked={compare.enabled}
          onChange={(e) => compare.setEnabled(e.currentTarget.checked)}
        />
        <span>Compare with before</span>
      </label>
      {note && (
        <span class={`we-compare-status we-compare-status-${compare.status}`} role="status">
          {note}
        </span>
      )}
    </div>
  );
}

type Shown = { key: string; before: BeforePage | null } | { key: string; failed: true };

/** The page before the inspected change, left of a draggable divider. */
export function CompareLayer({ host, page, pxPerPt, widthPx, heightPx }: PageOverlayProps) {
  const snap = useEditor(host);
  const review = useReview(host);
  const compare = useCompare(host);
  const [shown, setShown] = useState<Shown | null>(null);
  const entry = review.inspectedEntry();
  const active = Boolean(
    compare.enabled && compare.status !== "unavailable" && entry && snap.state && snap.state.revision >= entry.revision,
  );
  const dpr = globalThis.devicePixelRatio || 1;
  // The engine renders at an integer dpi; round so near zoom levels share an image.
  const scale = Math.max(1, Math.round(72 * Math.min(MAX_SCALE, pxPerPt * dpr))) / 72;
  const key = active && entry ? `${snap.state!.doc}|${entry.baseSha256}|${page}@${scale}|${compare.status}` : "";

  useEffect(() => {
    if (!key) return;
    let live = true;
    compare.beforePage(page, scale).then(
      (before) => live && setShown({ key, before }),
      () => live && setShown({ key, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [key]);

  if (!key || !shown || shown.key !== key || "failed" in shown) return null;
  const before = shown.before;
  if (!before) {
    return (
      <div class="we-compare-layer" data-testid={`review-compare-page-${page}`} data-before="missing">
        <span class="we-compare-missing">This page did not exist before this change</span>
      </div>
    );
  }

  // Size of the page shown now; the before image is stretched to it.
  const now = snap.state!.pages.find((p) => p.page === page) ?? before;
  const resized = Math.abs(now.widthPt - before.widthPt) > 0.5 || Math.abs(now.heightPt - before.heightPt) > 0.5;
  const title = resized
    ? `Before, the page was ${Math.round(before.widthPt)} x ${Math.round(before.heightPt)} pt. It is scaled to this page (${Math.round(now.widthPt)} x ${Math.round(now.heightPt)} pt).`
    : "Page before this change";
  const split = compare.position * widthPx;

  const fromPointer = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    if (box.width > 0) compare.setPosition((e.clientX - box.left) / box.width);
  };
  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: compare.position - STEP,
      ArrowDown: compare.position - STEP,
      ArrowRight: compare.position + STEP,
      ArrowUp: compare.position + STEP,
      Home: 0,
      End: 1,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    compare.setPosition(Math.round(next * 100) / 100);
  };

  return (
    <div class="we-compare-layer" data-testid={`review-compare-page-${page}`} data-before="shown">
      <div class="we-compare-before" style={{ width: `${split}px` }}>
        <img
          src={before.url}
          alt="Page before this change"
          title={title}
          draggable={false}
          style={{ width: `${widthPx}px`, height: `${heightPx}px` }}
        />
        <span class="we-compare-label we-compare-label-before" aria-hidden="true">
          Before
        </span>
      </div>
      <div class="we-compare-after" style={{ left: `${split}px` }}>
        <span class="we-compare-label we-compare-label-after" aria-hidden="true">
          After
        </span>
      </div>
      <div
        class="we-compare-handle"
        data-testid={`review-compare-handle-${page}`}
        role="slider"
        tabIndex={0}
        aria-label="Before and after divider"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(compare.position * 100)}
        aria-valuetext={`${Math.round(compare.position * 100)} percent before`}
        title={resized ? title : "Drag to compare before and after"}
        style={{ left: `${split}px` }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
