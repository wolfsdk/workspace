import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Address, Region } from "@wolfsdk/protocol";
import type { EditorHost } from "../host/index.ts";

type Props = {
  host: EditorHost;
  page: number;
  /** CSS pixels per point. */
  zoom: number;
  /** Identity changes with every revision, so region lists are re-read. */
  stateKey: string;
  selection: Address[];
  /** Selection chosen by a click in this layer (the scroller then skips scroll-into-view). */
  onSelect: (next: Address[]) => void;
};

function area(r: Region): number {
  return r.bbox_pt[2] * r.bbox_pt[3];
}

function boxStyle(r: Region, zoom: number) {
  const [x, y, w, h] = r.bbox_pt;
  return { left: `${x * zoom}px`, top: `${y * zoom}px`, width: `${w * zoom}px`, height: `${h * zoom}px` };
}

/**
 * Hover and click selection of the regions drawn on one page. Hit testing
 * picks the smallest region under the pointer (a run before its paragraph,
 * a cell before its table); clicking the same spot again walks outward to
 * the next enclosing region.
 *
 * Keyboard: the layer is one tab stop (a listbox). Tab / Shift+Tab and the
 * arrow keys move through the page's objects in reading order, leaving the
 * layer past the first or last; Enter or Space selects the object,
 * Shift+Enter adds or removes it.
 */
export function RegionLayer({ host, page, zoom, stateKey, selection, onSelect }: Props) {
  const [hover, setHover] = useState<Region | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const focusBox = useRef<HTMLDivElement>(null);
  // Smallest first, so the first hit is the most specific object.
  const regions = useMemo(() => [...host.regionsOn(page)].sort((a, b) => area(a) - area(b)), [host, page, stateKey]);
  // One region per object, in reading order (top, then left), for the keyboard.
  const ordered = useMemo(() => {
    const seen = new Set<string>();
    return [...regions]
      .sort((a, b) => a.bbox_pt[1] - b.bbox_pt[1] || a.bbox_pt[0] - b.bbox_pt[0] || area(b) - area(a))
      .filter((r) => !seen.has(r.object_id) && !!seen.add(r.object_id));
  }, [regions]);
  const selected = useMemo(() => {
    const set = new Set(selection);
    return regions.filter((r) => set.has(r.object_id));
  }, [regions, selection]);
  const current = active !== null ? ordered[Math.min(active, ordered.length - 1)] : undefined;

  // Keyboard moves bring the object into view; a click (which also focuses the layer) does not scroll.
  const keyMoved = useRef(false);
  useEffect(() => {
    if (!keyMoved.current) return;
    keyMoved.current = false;
    focusBox.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);

  function onFocus(event: FocusEvent) {
    if (event.target !== event.currentTarget || !ordered.length) return;
    const from = event.relatedTarget as Node | null;
    const fromAfter =
      !!from && !!((event.currentTarget as Node).compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
    const picked = ordered.findIndex((r) => r.object_id === selection[0]);
    setActive(picked >= 0 ? picked : fromAfter ? ordered.length - 1 : 0);
  }

  // Only Tab and Enter/Space: arrows, Delete and the rest stay with the plugins (nudging a shape, …).
  function onKeyDown(event: KeyboardEvent) {
    if (!ordered.length || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab") {
      const next = (active ?? (event.shiftKey ? ordered.length : -1)) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= ordered.length) return; // leave the layer
      event.preventDefault();
      keyMoved.current = true;
      setActive(next);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && current) {
      const id = current.object_id;
      // An already selected object lets Enter through (a plugin may start editing it).
      if (!event.shiftKey && selection.length === 1 && selection[0] === id) return;
      event.preventDefault();
      onSelect(
        event.shiftKey ? (selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]) : [id],
      );
    }
  }

  function hitsAt(event: MouseEvent): Region[] {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / zoom;
    const y = (event.clientY - rect.top) / zoom;
    return regions.filter(({ bbox_pt: [rx, ry, rw, rh] }) => x >= rx && y >= ry && x <= rx + rw && y <= ry + rh);
  }

  function onMove(event: MouseEvent) {
    const hit = hitsAt(event)[0] ?? null;
    if (hit !== hover) setHover(hit);
  }

  function onClick(event: MouseEvent) {
    const hits = hitsAt(event);
    if (!hits.length) {
      if (!event.shiftKey && selection.length) onSelect([]);
      return;
    }
    if (event.shiftKey) {
      const id = hits[0]!.object_id;
      onSelect(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
      return;
    }
    // Distinct objects under the pointer, innermost first.
    const ids = [...new Set(hits.map((h) => h.object_id))];
    const at = selection.length === 1 ? ids.indexOf(selection[0]!) : -1;
    onSelect([ids[at >= 0 ? (at + 1) % ids.length : 0]!]);
  }

  const primary = selection[0];
  const hoverNode = hover ? host.node(hover.object_id) : undefined;
  const focusId = `we-shell-region-focus-${page}`;
  const currentNode = current ? host.node(current.object_id) : undefined;
  return (
    <div
      class="we-shell-regions"
      data-testid={`shell-region-layer-${page}`}
      role="listbox"
      aria-label={`Objects on page ${page}`}
      aria-multiselectable="true"
      aria-activedescendant={current ? focusId : undefined}
      tabIndex={0}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      {current && (
        <div
          ref={focusBox}
          id={focusId}
          class="we-shell-region-focus"
          role="option"
          aria-selected={selection.includes(current.object_id)}
          aria-label={`${currentNode?.kind ?? "object"} ${current.object_id}`}
          data-testid="shell-region-focus"
          data-address={current.object_id}
          style={boxStyle(current, zoom)}
        >
          <span class="we-shell-region-label">
            {currentNode?.kind ?? "object"} {current.object_id}
          </span>
        </div>
      )}
      {selected.map((r, i) => (
        <div
          key={`${r.object_id}-${i}`}
          class={`we-shell-region-selected${r.object_id === primary ? " we-shell-region-primary" : ""}`}
          data-testid="shell-region-selected"
          data-address={r.object_id}
          style={boxStyle(r, zoom)}
        />
      ))}
      {hover && (
        <div
          class="we-shell-region-hover"
          data-testid="shell-region-hover"
          data-address={hover.object_id}
          style={boxStyle(hover, zoom)}
        >
          <span class="we-shell-region-label">
            {hoverNode?.kind ?? "object"} {hover.object_id}
          </span>
        </div>
      )}
    </div>
  );
}
