/**
 * Slide thumbnails: navigate (click, Up/Down), context actions (new slide
 * with layout choice, duplicate, delete, move up/down) and drag to reorder.
 */
import { dispatch, RAIL_KEYS, type RailActions } from "./keys.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type PageInfo } from "@wolfsdk/protocol";
import { useEditor, type EditorHost, type PluginProps } from "../../host/index.ts";
import { addSlide, deleteSlide, duplicateSlideCmd, goToPage, loadLayouts, moveSlideTo } from "./actions.ts";
import { deckOf, type SlideInfo } from "./model.ts";
import { useSlides } from "./store.ts";
import { eventInside, placeFixed } from "./dom.ts";

const THUMB_WIDTH = 168;

/** Thumbnails reuse the render `open`/`apply` already produced (served from
 * the kernel cache): a lower scale would re-render every page in the engine
 * after every edit (about 0.4 s per slide) and hold up the edit queue. */
function Thumb({ host, info, revisionKey }: { host: EditorHost; info: PageInfo; revisionKey: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    host.pageImageUrl(info.page, info.dpi / 72).then(
      (u) => live && setUrl(u),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [revisionKey, info.page]);
  const h = (THUMB_WIDTH * info.heightPt) / info.widthPt;
  return url ? (
    <img
      class="we-slides-thumb-img"
      src={url}
      width={THUMB_WIDTH}
      height={h}
      alt={`Slide ${info.page}`}
      draggable={false}
    />
  ) : (
    <div class="we-slides-thumb-img we-slides-thumb-blank" style={{ width: `${THUMB_WIDTH}px`, height: `${h}px` }} />
  );
}

/** Resolves once the host is not busy (immediately when it is idle). */
function whenIdle(host: EditorHost): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (!host.getSnapshot().busy) resolve();
  else {
    const off = host.subscribe(() => {
      if (host.getSnapshot().busy) return;
      off();
      resolve();
    });
  }
  return promise;
}

/** Fixed position in client pixels; `up` opens above the point. */
type Menu = { slide: SlideInfo; x: number; y: number; up: boolean; layouts: string[] | null | "loading" };

export function SlidesRail({ host }: PluginProps) {
  const snap = useEditor(host);
  const [ui] = useSlides(host);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    // `composedPath`: inside a shadow root `e.target` is retargeted to the
    // host element and every click would look like an outside click.
    const close = (e: Event) => {
      if (!eventInside(e, menuEl.current)) setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);

  // Placed once per opening and never moved afterwards: the layout list
  // arrives later and must not shift items under the pointer, so the menu is
  // capped to the space below its top and scrolls instead of moving.
  const menuEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = menuEl.current;
    if (!el || !menu) return;
    el.style.maxHeight = "";
    placeFixed(el, menu.x, menu.up ? menu.y - el.offsetHeight : menu.y, 8);
    const root = el.getRootNode();
    const bottom = Math.min(
      window.innerHeight,
      root instanceof ShadowRoot ? root.host.getBoundingClientRect().bottom : Infinity,
    );
    el.style.maxHeight = `min(70vh, ${Math.max(120, bottom - el.getBoundingClientRect().top - 8)}px)`;
  }, [menu?.slide.id, menu?.x, menu?.y, menu?.up]);

  // The layout listing is an engine call: while it runs the editor is busy.
  // An item picked meanwhile runs once the listing is done.
  const listing = useRef<Promise<unknown> | null>(null);

  // Keep the current thumbnail visible.
  useEffect(() => {
    list.current?.querySelector(".we-slides-thumb.is-current")?.scrollIntoView({ block: "nearest" });
  }, [snap.currentPage]);

  const state = snap.state;
  if (!state || state.format !== "pptx") return null;
  const deck = deckOf(state);
  const pages = new Map(state.pages.map((p) => [p.page, p]));
  const current = deck.byPage.get(snap.currentPage) ?? deck.slides[0];
  const index = current ? deck.slides.indexOf(current) : -1;
  const revisionKey = `${state.doc}:${state.sha256}`;
  const busy = snap.busy;
  const at = menu ? deck.slides.findIndex((s) => s.id === menu.slide.id) : -1;

  async function openMenu(slide: SlideInfo, x: number, y: number, up = false) {
    setMenu({ slide, x, y, up, layouts: "loading" });
    const pending = loadLayouts(host);
    listing.current = pending;
    const names = await pending;
    if (listing.current === pending) listing.current = null;
    setMenu((m) => (m && m.slide.id === slide.id ? { ...m, layouts: names } : m));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!current) return;
    const slide = current;
    const actions: RailActions = {
      step: (by) => {
        const next = deck.slides[index + by];
        if (next) {
          host.select([]);
          goToPage(host, next.page);
        }
        return true;
      },
      move: (by) => {
        if (!busy) void moveSlideTo(host, slide.id, index + by);
        return true;
      },
      edge: (end) => {
        const next = end ? deck.slides[deck.slides.length - 1] : deck.slides[0];
        if (next) goToPage(host, next.page);
        return true;
      },
      remove: () => !busy && (void deleteSlide(host, slide.id), true),
      duplicate: () => !busy && (void duplicateSlideCmd(host, slide.id), true),
      menu: () => {
        const el = list.current?.querySelector(".we-slides-thumb.is-current") as HTMLElement | null;
        const r = el?.getBoundingClientRect();
        void openMenu(slide, (r?.left ?? 0) + 24, (r?.top ?? 0) + 24);
        return true;
      },
    };
    if (dispatch(RAIL_KEYS, actions, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Runs a menu command. While the layout probe runs (the menu shows
   * `aria-busy`), the command is queued and runs once the probe has settled
   * and the host is idle again, so a click on "Same layout" is never dropped. */
  function act(fn: () => Promise<void>) {
    setMenu(null);
    const pending = listing.current;
    if (pending)
      void pending
        .catch(() => null)
        .then(() => whenIdle(host))
        .then(fn);
    else if (!busy) void fn();
  }

  return (
    <div class="we-slides-rail" data-testid="slides-rail">
      <div
        ref={list}
        class="we-slides-thumbs"
        role="listbox"
        aria-label="Slides"
        aria-activedescendant={current ? `we-slides-thumb-${current.page}` : undefined}
        tabIndex={0}
        data-testid="slides-thumbs"
        onKeyDown={onKeyDown}
      >
        {deck.slides.map((slide, i) => {
          const info = pages.get(slide.page);
          const isCurrent = slide === current;
          return (
            <div key={slide.id}>
              {dropAt === i && dragFrom !== null && <div class="we-slides-drop" data-testid="slides-drop-indicator" />}
              <div
                id={`we-slides-thumb-${slide.page}`}
                class={`we-slides-thumb${isCurrent ? " is-current" : ""}${dragFrom === i ? " is-dragging" : ""}`}
                role="option"
                aria-selected={isCurrent}
                data-testid={`slides-thumb-${slide.page}`}
                data-slide={slide.id}
                title={slide.title ? `Slide ${slide.page}: ${slide.title}` : `Slide ${slide.page}`}
                draggable={!busy}
                onClick={() => {
                  host.select([]);
                  goToPage(host, slide.page);
                  list.current?.focus();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  goToPage(host, slide.page);
                  void openMenu(slide, e.clientX, e.clientY);
                }}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer?.setData("text/plain", slide.id);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFrom;
                  const gap = dropAt;
                  setDragFrom(null);
                  setDropAt(null);
                  if (from === null || gap === null) return;
                  // Gap g lies before slide g; the final index after removal:
                  const to = gap > from ? gap - 1 : gap;
                  if (to !== from && !busy) void moveSlideTo(host, deck.slides[from]!.id, to);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDropAt(null);
                }}
              >
                <span class="we-slides-thumb-num">{slide.page}</span>
                {info && <Thumb host={host} info={info} revisionKey={revisionKey} />}
                <button
                  type="button"
                  class="we-btn we-btn--small we-slides-thumb-more"
                  data-testid={`slides-thumb-menu-${slide.page}`}
                  title="Slide actions"
                  aria-label={`Actions for slide ${slide.page}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    goToPage(host, slide.page);
                    void openMenu(slide, e.clientX, e.clientY);
                  }}
                >
                  ...
                </button>
              </div>
              {i === deck.slides.length - 1 && dropAt === i + 1 && dragFrom !== null && (
                <div class="we-slides-drop" data-testid="slides-drop-indicator" />
              )}
            </div>
          );
        })}
        {menu && (
          <div
            ref={menuEl}
            class="we-menu we-slides-menu"
            role="menu"
            aria-busy={menu.layouts === "loading" ? "true" : undefined}
            data-busy={menu.layouts === "loading" ? "true" : undefined}
            data-testid="slides-slide-menu"
          >
            <div class="we-slides-menu-title">New slide after</div>
            <button
              type="button"
              role="menuitem"
              data-testid="slides-new-slide-same"
              title="New slide with this slide's layout"
              aria-label="New slide with the same layout"
              onClick={() => act(() => addSlide(host, menu.slide.id))}
            >
              Same layout
            </button>
            <hr />
            <button
              type="button"
              role="menuitem"
              data-testid="slides-duplicate-slide"
              title="Duplicate slide (Cmd+D in the rail)"
              aria-label="Duplicate slide"
              onClick={() => act(() => duplicateSlideCmd(host, menu.slide.id))}
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="slides-move-slide-up"
              title="Move slide up (Cmd+Up in the rail)"
              aria-label="Move slide up"
              disabled={at <= 0}
              onClick={() => act(() => moveSlideTo(host, menu.slide.id, at - 1))}
            >
              Move up
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="slides-move-slide-down"
              title="Move slide down (Cmd+Down in the rail)"
              aria-label="Move slide down"
              disabled={at < 0 || at >= deck.slides.length - 1}
              onClick={() => act(() => moveSlideTo(host, menu.slide.id, at + 1))}
            >
              Move down
            </button>
            <button
              type="button"
              role="menuitem"
              class="we-btn--danger-quiet"
              data-testid="slides-delete-slide"
              title="Delete slide (Delete in the rail)"
              aria-label="Delete slide"
              onClick={() => act(() => deleteSlide(host, menu.slide.id))}
            >
              Delete
            </button>
            <hr />
            <div class="we-slides-menu-title">New slide with layout</div>
            {menu.layouts === "loading" && (
              <div class="we-slides-menu-note" data-testid="slides-layouts-loading">
                Listing layouts
              </div>
            )}
            {Array.isArray(menu.layouts) &&
              menu.layouts.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="menuitem"
                  data-testid={`slides-new-slide-layout-${i}`}
                  title={`New slide with layout ${name}`}
                  aria-label={`New slide with layout ${name}`}
                  onClick={() => act(() => addSlide(host, menu.slide.id, name))}
                >
                  {name}
                </button>
              ))}
          </div>
        )}
      </div>
      <div class="we-slides-rail-foot">
        <button
          type="button"
          class="we-btn we-btn--outline"
          data-testid="slides-new-slide"
          title="New slide after the current one"
          aria-label="New slide"
          disabled={!current || busy}
          onClick={(e) => {
            if (!current) return;
            const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
            void openMenu(current, b.left, b.top - 4, true);
          }}
        >
          New slide
        </button>
        {ui.disabled["slide-move"] && (
          <span class="we-slides-muted" title={ui.disabled["slide-move"].message} data-testid="slides-move-fallback">
            Reorder uses clone + delete
          </span>
        )}
      </div>
    </div>
  );
}
