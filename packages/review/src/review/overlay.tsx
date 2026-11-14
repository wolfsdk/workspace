import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  boxesOnPage,
  entryKey,
  formatTyped,
  outlined,
  placeTags,
  readingOrder,
  sideShown,
  type Rect,
  type TagRequest,
} from "@wolfsdk/protocol";
import { useEditor, type EditorHost, type PageOverlayProps } from "../host/index.ts";
import { useReview } from "./hooks.ts";
import { enterContext, focusChange, handleOutlineKey, outlineLayers, outlinesOf } from "./keys.ts";
import type { ReviewStore } from "./store.ts";
import { CompareLayer } from "./compareView.tsx";

/** The before/after comparison (when on) under the inspected entry's change outlines. */
export function ReviewOverlay(props: PageOverlayProps) {
  return (
    <>
      <CompareLayer {...props} />
      <ChangeOutlines {...props} />
    </>
  );
}

/** Rendered size in CSS px of a tag per text. The font comes from the theme, so the first render
 * estimates and the layout effect below records the real size once per text. */
const tagSizes = new Map<string, [number, number]>();

/** Keyboard focus of a host's outlines, across its pages. `selection`: the selected change the
 * last focus pass saw. `lost`: a re-render removed the focused outline (the focus fell back to
 * the body); the next pass puts it back, unless the reviewer clicks or focuses anything first. */
type FocusState = { selection: string | null; lost: boolean; queued: boolean };
const focusStates = new WeakMap<EditorHost, FocusState>();

function focusStateOf(host: EditorHost): FocusState {
  let s = focusStates.get(host);
  if (!s) focusStates.set(host, (s = { selection: null, lost: false, queued: false }));
  return s;
}

/** The focused element of the document or shadow root `el` is in. */
function activeIn(el: Element): Element | null {
  const root = el.getRootNode();
  return root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
}

const focusWithin = (el: Element | null): boolean => {
  const active = el ? activeIn(el) : null;
  return active !== null && el!.contains(active);
};

const nothingFocused = (): boolean => {
  const a = document.activeElement;
  return a === null || a === document.body || a === document.documentElement;
};

function markLost(s: FocusState): void {
  if (s.lost) return;
  s.lost = true;
  const clear = () => {
    s.lost = false;
    document.removeEventListener("pointerdown", clear, true);
    document.removeEventListener("focusin", clear, true);
  };
  document.addEventListener("pointerdown", clear, true);
  document.addEventListener("focusin", clear, true);
}

/** One focus pass per render batch (every page's layer has committed by then). */
function queueFocusPass(host: EditorHost, store: ReviewStore): void {
  const s = focusStateOf(host);
  if (s.queued) return;
  s.queued = true;
  queueMicrotask(() => {
    s.queued = false;
    focusPass(host, store, s);
  });
}

/**
 * One tab stop for all of a host's outlines (roving tabindex): the focused outline while the
 * focus is on one, else the selected change's first outline, else the first outline in reading
 * order. A selection made while the focus is on an outline (Alt+ArrowDown) takes the focus to the
 * selected change's outline, or to its row in the panel when the change draws no outline, so the
 * focus never stays on another change's outline; a focus lost to a re-render goes to the tab stop.
 * Reads no layout.
 */
function focusPass(host: EditorHost, store: ReviewStore, s: FocusState): void {
  const all = outlinesOf(host);
  const active = all[0] ? activeIn(all[0]) : null;
  let focused = all.find((el) => el === active) ?? null;
  const selected = all.filter((el) => el.classList.contains("we-review-selected"));
  const sel = store.ui.selectedChange;
  const selection = sel ? `${sel.revision}:${sel.index}` : null;
  let lost = !focused && s.lost && nothingFocused();
  let target: HTMLElement | null = null;
  if (selection !== s.selection) {
    const entry = sel ? store.history().find((e) => e.revision === sel.revision) : undefined;
    // The pages show the selected change's revision and no region carries the change.
    const none =
      !!sel && !!entry && selected.length === 0 && outlined(entry, sel.index, host.getSnapshot().state) === false;
    if (focused && selected.length > 0 && !selected.includes(focused)) target = selected[0]!;
    else if (none && (focused || lost) && focusChange(store, sel!.revision, sel!.index)) {
      focused = null;
      lost = false;
    }
    // While the focus is on an outline (or was, until a re-render) and the selected one is not
    // drawn yet, keep waiting for it.
    if (!sel || selected.length > 0 || none || (!focused && !lost)) s.selection = selection;
  }
  if (lost) target = selected[0] ?? all[0] ?? null;
  const stop = target ?? focused ?? selected[0] ?? all[0] ?? null;
  for (const el of all) {
    const tabIndex = el === stop ? "0" : "-1";
    if (el.getAttribute("tabindex") !== tabIndex) el.setAttribute("tabindex", tabIndex);
    // The listbox's name as description (see `enterContext`): on the tab stop while the focus is
    // elsewhere, and on the focused outline for as long as it keeps the focus it came in with.
    if (!focused && el === stop) enterContext(el, null);
    else if (el !== focused) el.removeAttribute("aria-describedby");
  }
  if (target) {
    enterContext(target, focused);
    target.focus();
  }
}

/** What a screen reader announces for an outline: change type, kind, address, the property change. */
function outlineName(
  change: { change: string; kind: string; property?: string; before?: unknown; after?: unknown },
  address: string,
  rejected: boolean,
): string {
  const values = change.property
    ? `, ${change.property} from ${formatTyped(change.before)} to ${formatTyped(change.after)}`
    : "";
  return `${change.change} ${change.kind} ${address}${values}${rejected ? ", rejected" : ""}`;
}

let layerCount = 0;

/** Outlines of the inspected entry's changes on one page, by change type. Each outline carries a tag
 * naming its change type, placed by `placeTags` where it covers no other content; a tag with no such
 * place is shown only while its outline is hovered, focused or its change selected. The outlines are
 * one listbox per page in reading order, with one tab stop for all pages (see `focusPass`); the keys
 * are `handleOutlineKey` (keys.ts). */
function ChangeOutlines({ host, page, pxPerPt, widthPx, heightPx }: PageOverlayProps) {
  const snap = useEditor(host);
  const store = useReview(host);
  const layer = useRef<HTMLDivElement>(null);
  const registered = useRef<HTMLDivElement | null>(null);
  // The outlines name their listbox through this id (see `enterContext`).
  const [layerId] = useState(() => `we-review-layer-${++layerCount}`);
  const [, remeasured] = useState(0);
  // Whether the focus is on this page's outlines before this render replaces them.
  const hadFocus = focusWithin(layer.current);
  useLayoutEffect(() => {
    let changed = false;
    for (const el of layer.current?.querySelectorAll<HTMLElement>(".we-review-tag") ?? []) {
      const size: [number, number] = [el.offsetWidth, el.offsetHeight];
      const known = tagSizes.get(el.textContent ?? "");
      if (size[0] && (!known || known[0] !== size[0] || known[1] !== size[1])) {
        tagSizes.set(el.textContent ?? "", size);
        changed = true;
      }
    }
    if (changed) remeasured((n) => n + 1);
  });
  useLayoutEffect(() => {
    const el = layer.current;
    if (registered.current !== el) {
      if (registered.current) outlineLayers(host).delete(registered.current);
      if (el) outlineLayers(host).add(el);
      registered.current = el;
    }
    if (hadFocus && !focusWithin(el) && nothingFocused()) markLost(focusStateOf(host));
    queueFocusPass(host, store);
  });
  useLayoutEffect(
    () => () => {
      const el = registered.current;
      if (!el) return;
      outlineLayers(host).delete(el);
      if (focusWithin(el)) markLost(focusStateOf(host));
      queueFocusPass(host, store);
    },
    [],
  );
  const entry = store.inspectedEntry();
  if (!entry || !snap.state) return null;
  const side = sideShown(entry, snap.state);
  if (!side) return null;
  const regions = host.regionsOn(page);
  const boxes = boxesOnPage(entry, side, regions);
  if (boxes.length === 0) return null;
  const boxRects = boxes.map((b) => b.region.bbox_pt.map((v) => v * pxPerPt) as Rect);
  const tags = placeTags(
    boxes.map(({ change }, i): TagRequest => ({
      box: boxRects[i]!,
      text: change.change,
      size: tagSizes.get(change.change) ?? [change.change.length * 7 + 8, 14],
    })),
    regions.map((r) => r.bbox_pt.map((v) => v * pxPerPt) as Rect),
    [widthPx, heightPx],
  );
  const selected = store.ui.selectedChange?.revision === entry.revision ? store.ui.selectedChange.index : -1;
  const rejected = store.decisionOf(entry) === "reject";
  const ek = entryKey(entry);
  // Several changes of one object draw stacked outlines; only the first is filled, so the fills do
  // not add up over the changed content.
  const filled = new Set<string>();
  return (
    <div
      ref={layer}
      id={layerId}
      class="we-review-layer"
      data-testid={`review-overlay-page-${page}`}
      data-side={side}
      data-page={page}
      data-revision={entry.revision}
      role="listbox"
      aria-label={`Changes of #${entry.revision} ${entry.label} on page ${page}${side === "before" ? ", before the change" : ""}`}
      onKeyDown={(e) => handleOutlineKey(e, host)}
      onFocusIn={() => queueFocusPass(host, store)}
      onFocusOut={() => queueFocusPass(host, store)}
    >
      {readingOrder(boxRects).map((i) => {
        const { index, change, address } = boxes[i]!;
        const [x, y, w, h] = boxRects[i]!;
        const { rect, free } = tags[i]!;
        const key = boxRects[i]!.join(",");
        const stacked = filled.has(key);
        filled.add(key);
        return (
          <div
            // A new entry gets new elements, so a focused outline never turns into another change.
            key={`${ek}:${index}:${i}`}
            class={`we-review-box we-review-${change.change} we-review-side-${side}${stacked ? " we-review-stacked" : ""}${index === selected ? " we-review-selected" : ""}${rejected ? " we-review-rejected" : ""}`}
            style={{ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }}
            role="option"
            aria-selected={index === selected}
            aria-label={outlineName(change, address, rejected)}
            data-testid={`review-overlay-${index}`}
            data-index={index}
            data-change={change.change}
            data-address={address}
            onClick={() => void store.selectChange(entry, index)}
          >
            <span
              class={`we-review-tag${free ? "" : " we-review-tag-on-demand"}`}
              aria-hidden="true"
              style={{
                left: `calc(${rect[0] - x}px - var(--we-review-border))`,
                top: `calc(${rect[1] - y}px - var(--we-review-border))`,
              }}
            >
              {change.change}
            </span>
          </div>
        );
      })}
    </div>
  );
}
