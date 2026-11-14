import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismiss } from "./chrome.tsx";
import { Icon, type IconName } from "./icons.tsx";

export type PanelTab = {
  /** Selection key (unique). */
  key: string;
  /** Panel id: tab element id `we-shell-tab-<id>`, test id `shell-tab-<id>`. */
  id: string;
  title: string;
};

/** full: icon + title; short: icon + short label; compact: the selected tab icon + short label, the rest icon only. */
type Mode = "full" | "short" | "compact";
type Fit = { mode: Mode; hidden: ReadonlySet<string> };

const ALL_VISIBLE: Fit = { mode: "full", hidden: new Set() };

/** An icon for a panel from its id and title (the plugin contract carries no icon). */
function iconFor(tab: PanelTab): IconName {
  const text = `${tab.id} ${tab.title}`.toLowerCase();
  if (/inspect/.test(text)) return "tree";
  if (/comment/.test(text)) return "comment";
  if (/track|revision|change/.test(text)) return "track";
  if (/review|diff|compare/.test(text)) return "diff";
  if (/find|search/.test(text)) return "search";
  if (/note/.test(text)) return "note";
  return "layers";
}

/** The first word of the title, at most 10 characters. */
function shortLabel(title: string): string {
  const first = title.trim().split(/\s+/)[0] ?? title;
  return first.length > 10 ? `${first.slice(0, 9)}…` : first;
}

/**
 * Choose how the tabs fit `available` pixels: full titles, else short labels,
 * else compact (short label on the active tab, icons on the rest), else
 * compact for as many tabs as fit beside the More button (the active tab
 * always among them) with the rest in its menu.
 */
function fitTabs(
  tabs: PanelTab[],
  active: string,
  available: number,
  gap: number,
  full: number[],
  short: number[],
  icon: number[],
  more: number,
): Fit {
  const total = (widths: number[]) => widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total(full) <= available) return ALL_VISIBLE;
  if (total(short) <= available) return { mode: "short", hidden: new Set() };
  const activeAt = Math.max(
    0,
    tabs.findIndex((t) => t.key === active),
  );
  const compact = icon.map((w, i) => (i === activeAt ? short[i]! : w));
  if (total(compact) <= available) return { mode: "compact", hidden: new Set() };
  const budget = available - more - gap;
  const shown = new Set<number>([activeAt]);
  let used = compact[activeAt]!;
  for (let i = 0; i < tabs.length; i++) {
    if (i === activeAt) continue;
    if (used + gap + compact[i]! > budget) continue;
    used += gap + compact[i]!;
    shown.add(i);
  }
  return { mode: "compact", hidden: new Set(tabs.filter((_, i) => !shown.has(i)).map((t) => t.key)) };
}

/**
 * The side panel tab strip (WAI-ARIA tabs, automatic activation): icon and
 * title per tab, shrinking to icon and short label, then to icons with the
 * selected tab labelled, then moving tabs that do not fit into a More menu. It never scrolls sideways. Every tab stays in the
 * tablist (overflowed ones `hidden`), so each tabpanel's `aria-labelledby`
 * resolves; Left/Right/Home/End move through all tabs, overflowed included.
 */
export function PanelTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: PanelTab[];
  active: string;
  onSelect: (key: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const moreWrap = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit>(ALL_VISIBLE);
  const [open, setOpen] = useState(false);
  const focusActive = useRef(false);
  const signature = tabs.map((t) => `${t.key}\u0000${t.title}`).join("\u0001");

  const relayout = useRef(() => {});
  relayout.current = () => {
    const outer = wrap.current;
    const probe = measure.current;
    const strip = list.current;
    if (!outer || !probe || !strip) return;
    const style = getComputedStyle(outer);
    const available = outer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    const width = (selector: string) =>
      [...probe.querySelectorAll<HTMLElement>(selector)].map((el) => Math.ceil(el.getBoundingClientRect().width));
    const full = width("[data-measure=full]");
    const short = width("[data-measure=short]");
    const icon = width("[data-measure=icon]");
    const more = width("[data-measure=more]")[0] ?? 32;
    if (full.length !== tabs.length || available <= 0) return;
    const next = fitTabs(tabs, active, available, gap, full, short, icon, more);
    setFit((prev) =>
      prev.mode === next.mode &&
      prev.hidden.size === next.hidden.size &&
      [...next.hidden].every((key) => prev.hidden.has(key))
        ? prev
        : next,
    );
  };

  useLayoutEffect(() => relayout.current(), [signature, active]);
  useEffect(() => {
    const observer = new ResizeObserver(() => relayout.current());
    if (wrap.current) observer.observe(wrap.current);
    // Web fonts arriving change the measured widths.
    if (measure.current) observer.observe(measure.current);
    return () => observer.disconnect();
  }, []);

  // After a keyboard move the selected tab may have just become visible: focus it once laid out.
  useLayoutEffect(() => {
    if (!focusActive.current) return;
    const tab = list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!tab || tab.hidden) return;
    focusActive.current = false;
    tab.focus();
  });

  useDismiss(open, moreWrap, () => {
    setOpen(false);
    moreButton.current?.focus();
  });
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (fit.hidden.size === 0) setOpen(false);
  }, [fit]);

  const select = (key: string, focus: boolean) => {
    focusActive.current = focus;
    onSelect(key);
  };

  const onListKey = (event: KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.key === active);
    let next: number;
    if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    select(tabs[next]!.key, true);
  };

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(event.target as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]!.focus();
  };

  const overflowed = tabs.filter((t) => fit.hidden.has(t.key));

  return (
    <div class={`we-shell-tabbar is-${fit.mode}`} ref={wrap}>
      <div class="we-shell-tabs" role="tablist" aria-label="Side panels" ref={list} onKeyDown={onListKey}>
        {tabs.map((t) => {
          const selected = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              class="we-shell-tab"
              role="tab"
              id={`we-shell-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`we-shell-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              hidden={fit.hidden.has(t.key)}
              title={t.title}
              aria-label={t.title}
              data-testid={`shell-tab-${t.id}`}
              onClick={() => select(t.key, false)}
            >
              <Icon name={iconFor(t)} />
              {(fit.mode !== "compact" || selected) && (
                <span class="we-shell-tab-label">{fit.mode === "full" ? t.title : shortLabel(t.title)}</span>
              )}
            </button>
          );
        })}
      </div>
      {overflowed.length > 0 && (
        <div class="we-shell-tabs-more" ref={moreWrap}>
          <button
            ref={moreButton}
            type="button"
            class="we-btn we-btn--icon we-btn--small"
            title={`More panels: ${overflowed.map((t) => t.title).join(", ")}`}
            aria-label={`More panels (${overflowed.length})`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls="we-shell-tabs-menu"
            data-testid="shell-tabs-more"
            onClick={() => setOpen(!open)}
          >
            <Icon name="more" />
          </button>
          {open && (
            <div
              ref={menu}
              class="we-menu we-shell-tabs-menu"
              role="menu"
              id="we-shell-tabs-menu"
              aria-label="More panels"
              data-testid="shell-tabs-menu"
              onKeyDown={onMenuKey}
            >
              {overflowed.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  class="we-menu-item"
                  role="menuitem"
                  tabIndex={-1}
                  title={t.title}
                  aria-label={t.title}
                  data-testid={`shell-tabs-menu-${t.id}`}
                  onClick={() => {
                    setOpen(false);
                    select(t.key, true);
                  }}
                >
                  <Icon name={iconFor(t)} />
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div class="we-shell-tabs-measure" ref={measure} aria-hidden="true">
        {tabs.map((t) => (
          <span key={`f-${t.key}`} class="we-shell-tab" data-measure="full">
            <Icon name={iconFor(t)} />
            <span class="we-shell-tab-label">{t.title}</span>
          </span>
        ))}
        {tabs.map((t) => (
          <span key={`s-${t.key}`} class="we-shell-tab" data-measure="short">
            <Icon name={iconFor(t)} />
            <span class="we-shell-tab-label">{shortLabel(t.title)}</span>
          </span>
        ))}
        {tabs.map((t) => (
          <span key={`i-${t.key}`} class="we-shell-tab" data-measure="icon">
            <Icon name={iconFor(t)} />
          </span>
        ))}
        <span class="we-btn we-btn--icon we-btn--small" data-measure="more">
          <Icon name="more" />
        </span>
      </div>
    </div>
  );
}
