/** @jsxImportSource preact */
// The quick switcher (Cmd+K or Ctrl+K): type to filter documents of the room and rooms, Enter to go.
import type { WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { FormatPill, Icon } from "./common.tsx";

export type SwitcherItem =
  | { kind: "doc"; id: string; format: WorkspaceDocFormat; meta: string }
  | { kind: "room"; id: string; meta: string };

/** Items whose id holds every word of `query`, in any order and case; documents before rooms, as given. */
export function filterItems(items: readonly SwitcherItem[], query: string): SwitcherItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => words.every((w) => item.id.toLowerCase().includes(w)));
}

export function Switcher({ items, onPick, onClose }: { items: SwitcherItem[]; onPick(item: SwitcherItem): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => filterItems(items, query), [items, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <div class="sheet-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="switcher" role="dialog" aria-modal="true" aria-label="Switch document or room">
        <label class="switcher-search">
          <Icon name="search" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-list"
            aria-activedescendant={shown.length > 0 ? `switcher-${index}` : undefined}
            placeholder="Jump to a document or room"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const item = shown[index];
                if (item) onPick(item);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <ul class="switcher-list" id="switcher-list" role="listbox" ref={list}>
          {shown.length === 0 ? <li class="switcher-empty">Nothing matches {query}</li> : null}
          {shown.map((item, i) => (
            <li
              key={`${item.kind}:${item.id}`}
              id={`switcher-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === index}
              class={`switcher-item${i === index ? " is-active" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => onPick(item)}
            >
              {item.kind === "doc" ? <FormatPill format={item.format} /> : <span class="pill pill--room">ROOM</span>}
              <span class="switcher-id">{item.id}</span>
              <span class="switcher-meta">{item.meta}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
