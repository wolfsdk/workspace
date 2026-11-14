/**
 * Context menu shared by the sheet tabs and the grid (cells, row and
 * column headers): fixed at the pointer, closed by an outside pointer
 * down, Escape or choosing an item. Items whose control the engine
 * module refused stay listed, disabled, with the refusal code in their title.
 */
import { useEffect, useRef } from "preact/hooks";
import type { SheetsStore } from "./store.ts";

export type MenuItem = {
  /** Store control (refusal-disabled state) of the batch the item sends. */
  control?: string;
  testid: string;
  label: string;
  enabled?: boolean;
  act: () => void;
};

export function Menu({
  store,
  x,
  y,
  testid,
  up = false,
  items,
  close,
}: {
  store: SheetsStore;
  x: number;
  y: number;
  testid: string;
  /** Open above the pointer (bottom bar). */
  up?: boolean;
  items: (MenuItem | "separator")[];
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = ref.current;
    // Inside a shadow root a document listener sees `e.target` retargeted
    // to the host element: test the composed path instead.
    const onDown = (e: PointerEvent) => {
      if (!menu || !e.composedPath().includes(menu)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      class={`we-menu we-sheets-menu${up ? " we-sheets-menu-up" : ""}`}
      role="menu"
      data-testid={testid}
      style={{ left: `${x}px`, top: `${y}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it === "separator") return <hr key={`sep-${i}`} class="we-menu-sep" />;
        const refused = it.control ? store.isDisabled(it.control) : undefined;
        return (
          <button
            key={it.testid}
            type="button"
            role="menuitem"
            data-testid={it.testid}
            data-refused={refused?.code}
            title={refused ? `${it.label}: refused by the engine (${refused.code}): ${refused.message}` : it.label}
            aria-label={it.label}
            disabled={it.enabled === false || !!refused}
            onClick={() => {
              close();
              it.act();
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
