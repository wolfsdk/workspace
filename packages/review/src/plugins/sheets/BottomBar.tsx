/**
 * Bottom strip: sheet tabs (switch, add, rename, duplicate, delete, reorder
 * by drag or menu) and the status area (sum / count / average of the
 * selection).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { EditorHost } from "../../host/index.ts";
import { Menu } from "./Menu.tsx";
import { formatGeneral, type SheetModel } from "./model.ts";
import { useSheets, type SheetsStore } from "./store.ts";

export function SheetsBottomBar({ host }: { host: EditorHost }) {
  const store = useSheets(host);
  const state = host.getSnapshot().state;
  if (!state || state.format !== "xlsx") return null;
  return (
    <div class="we-sheets-bottom" data-testid="sheets-bottom">
      <SheetTabs store={store} />
      <Status store={store} />
    </div>
  );
}

function SheetTabs({ store }: { store: SheetsStore }) {
  const model = store.model;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ sheetId: number; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  if (!model) return null;
  const visible = model.sheets.filter((s) => s.visible);
  const addRefused = store.isDisabled("add-sheet");
  return (
    <div class="we-sheets-tabs" role="tablist" aria-label="Sheets" data-testid="sheets-tabs">
      {model.sheets.map((s) =>
        renaming === s.sheetId ? (
          <RenameInput key={s.sheetId} store={store} sheet={s} done={() => setRenaming(null)} />
        ) : (
          <button
            key={s.sheetId}
            type="button"
            role="tab"
            class={`we-sheets-tab${s.sheetId === store.activeSheetId ? " we-sheets-tab-active" : ""}${s.visible ? "" : " we-sheets-tab-hidden"}${dragId === s.sheetId ? " we-sheets-tab-drag" : ""}`}
            aria-selected={s.sheetId === store.activeSheetId}
            data-testid={`sheets-tab-${s.position}`}
            data-sheet={s.name}
            title={
              s.visible
                ? `${s.name} (double-click to rename, right-click for more)`
                : `${s.name}: ${s.hiddenReason ?? "hidden"} sheet`
            }
            aria-label={s.visible ? `Sheet ${s.name}` : `Hidden sheet ${s.name}`}
            draggable={s.visible && !store.isDisabled("move-sheet")}
            onClick={() => store.switchSheet(s.sheetId)}
            onDblClick={() => !store.isDisabled("rename-sheet") && setRenaming(s.sheetId)}
            onContextMenu={(e) => {
              e.preventDefault();
              store.switchSheet(s.sheetId);
              setMenu({ sheetId: s.sheetId, x: e.clientX, y: e.clientY });
            }}
            onDragStart={(e) => {
              setDragId(s.sheetId);
              e.dataTransfer?.setData("text/plain", s.name);
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => dragId !== null && dragId !== s.sheetId && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId === null || dragId === s.sheetId) return;
              const from = model.sheets.findIndex((x) => x.sheetId === dragId);
              const to = model.sheets.indexOf(s);
              store.moveSheet(dragId, s.sheetId, from < to ? "after" : "before");
              setDragId(null);
            }}
          >
            {s.name}
            {!s.visible && <span class="we-sheets-tab-note"> (hidden)</span>}
          </button>
        ),
      )}
      <button
        type="button"
        class="we-btn we-btn--small we-sheets-add"
        data-testid="sheets-add-sheet"
        title={
          addRefused ? `Add sheet: refused by the engine (${addRefused.code})` : "Add a sheet after the active one"
        }
        aria-label="Add sheet"
        disabled={!!addRefused}
        onClick={() => void store.addSheet()}
      >
        + Sheet
      </button>
      {menu && (
        <TabMenu
          store={store}
          sheet={model.byId.get(menu.sheetId)!}
          x={menu.x}
          y={menu.y}
          canDelete={visible.length > 1}
          close={() => setMenu(null)}
          rename={() => {
            setRenaming(menu.sheetId);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

function RenameInput({ store, sheet, done }: { store: SheetsStore; sheet: SheetModel; done: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(sheet.name);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = async () => {
    if (finished.current) return;
    finished.current = true;
    await store.renameSheet(sheet.sheetId, value);
    done();
    store.focusGrid();
  };
  return (
    <input
      ref={ref}
      class="we-input we-sheets-tab-input"
      data-testid="sheets-tab-rename-input"
      aria-label={`New name for sheet ${sheet.name}`}
      title="Enter to rename, Escape to cancel"
      value={value}
      maxLength={31}
      onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          finished.current = true;
          done();
          store.focusGrid();
        }
      }}
    />
  );
}

function TabMenu({
  store,
  sheet,
  x,
  y,
  canDelete,
  close,
  rename,
}: {
  store: SheetsStore;
  sheet: SheetModel;
  x: number;
  y: number;
  canDelete: boolean;
  close: () => void;
  rename: () => void;
}) {
  const model = store.model!;
  const visible = model.sheets.filter((s) => s.visible);
  const i = visible.indexOf(sheet);
  const prev = i > 0 ? visible[i - 1] : undefined;
  const next = i >= 0 && i < visible.length - 1 ? visible[i + 1] : undefined;
  return (
    <Menu
      store={store}
      x={x}
      y={y}
      up
      testid="sheets-tab-menu"
      close={close}
      items={[
        {
          control: "rename-sheet",
          testid: "sheets-tab-rename-sheet",
          label: "Rename",
          enabled: sheet.visible,
          act: rename,
        },
        {
          control: "duplicate-sheet",
          testid: "sheets-tab-duplicate-sheet",
          label: "Duplicate",
          enabled: sheet.visible,
          act: () => void store.duplicateSheet(sheet.sheetId),
        },
        {
          control: "delete-sheet",
          testid: "sheets-tab-delete-sheet",
          label: "Delete",
          enabled: canDelete && sheet.visible,
          act: () => void store.deleteSheet(sheet.sheetId),
        },
        {
          control: "move-sheet",
          testid: "sheets-tab-move-sheet-left",
          label: "Move left",
          enabled: !!prev,
          act: () => prev && store.moveSheet(sheet.sheetId, prev.sheetId, "before"),
        },
        {
          control: "move-sheet",
          testid: "sheets-tab-move-sheet-right",
          label: "Move right",
          enabled: !!next,
          act: () => next && store.moveSheet(sheet.sheetId, next.sheetId, "after"),
        },
      ]}
    />
  );
}

function Status({ store }: { store: SheetsStore }) {
  const stats = store.stats();
  const { fresh } = store.currentReads;
  const busy = store.host.getSnapshot().busy;
  return (
    <div class="we-sheets-status" data-testid="sheets-status" aria-live="polite">
      {(busy || !fresh) && !store.readError && (
        <span class="we-sheets-muted" data-testid="sheets-status-busy">
          {busy ? "Working" : "Reading formatted values"}
        </span>
      )}
      {stats && stats.count > 0 && (
        <>
          {stats.numeric > 0 && (
            <>
              <span data-testid="sheets-stat-sum">Sum: {formatGeneral(stats.sum)}</span>
              <span data-testid="sheets-stat-average">Average: {formatGeneral(stats.sum / stats.numeric)}</span>
            </>
          )}
          <span data-testid="sheets-stat-count">Count: {stats.count}</span>
        </>
      )}
    </div>
  );
}
