/**
 * Toolbar: one row. Common text controls are inline icon buttons; insert,
 * arrange, table structure and slide operations live in menus.
 */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useEditor, type EditorHost, type PluginProps } from "../../host/index.ts";
import {
  addSlide,
  alignShapes,
  applyFormat,
  currentSlide,
  deck,
  deleteSelection,
  deleteSlide,
  distributeShapes,
  duplicateShapes,
  duplicateSlideCmd,
  formatState,
  type ColorState,
  formatTargets,
  insertPictureFile,
  isPictureFile,
  moveSlideTo,
  pasteShapes,
  restackShapes,
  selectedShapes,
  stepShapes,
  tableDeleteColumn,
  tableDeleteRow,
  tableFocus,
  tableInsertColumn,
  tableInsertRow,
  toggleFont,
  type AlignEdge,
} from "./actions.ts";
import { PICTURE_TYPES, SHAPE_GEOMETRIES, type FormatPatch } from "./ops.ts";
import { activeElement, eventInside, eventOrigin, placeFixed, typing } from "./dom.ts";
import { SlideShow } from "./SlideShow.tsx";
import { storeOf, useSlides } from "./store.ts";

const FONTS = [
  "Calibri",
  "Arial",
  "Helvetica",
  "Segoe UI",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Times New Roman",
  "Garamond",
  "Courier New",
];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96];
const LINE_WIDTHS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6];

// ---------------------------------------------------------------------------
// Icons (16 px, stroke = currentColor)
// ---------------------------------------------------------------------------

const ICONS: Record<string, JSX.Element> = {
  "text-left": <path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8" />,
  "text-center": <path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8" />,
  "text-right": <path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8" />,
  "text-justify": <path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" />,
  "anchor-top": <path d="M2 2h12M5 5h6v4H5z" />,
  "anchor-middle": <path d="M2 8h2.5M11.5 8H14M5 5.5h6v5H5z" />,
  "anchor-bottom": <path d="M2 14h12M5 7h6v4H5z" />,
  duplicate: <path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" />,
  delete: <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />,
  show: <path d="M1.5 2.5h13v9h-13zM6.5 5v4l3.5-2zM8 11.5v2M5 14h6" />,
  "font-color": <path d="M4.5 11 8 2.5 11.5 11M5.7 8h4.6M2 14h12" />,
  fill: (
    <path d="M3 8.5 7.5 4l4.5 4.5-4.5 4.5zM12.5 10.5s1.2 1.5 1.2 2.3a1.2 1.2 0 0 1-2.4 0c0-.8 1.2-2.3 1.2-2.3zM5.5 2l2 2" />
  ),
  line: <path d="M2.5 13.5l11-11" />,
  caret: <path d="M4.5 6.5 8 10l3.5-3.5" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      class="we-slides-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

function IconButton(props: {
  testid: string;
  label: string;
  title: string;
  icon: string;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={`we-btn we-btn--icon${props.danger ? " we-btn--danger-quiet" : ""}`}
      data-testid={props.testid}
      title={props.title}
      aria-label={props.label}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/**
 * A toolbar menu button. The popup is `position: fixed` under the button so
 * the shell's toolbar row never wraps or clips it. Escape and a click outside
 * close it; Up/Down move between items.
 */
function Menu({
  testid,
  label,
  title,
  pressed,
  disabled,
  children,
}: {
  testid: string;
  label: string;
  title: string;
  pressed?: boolean;
  disabled?: boolean;
  children: (close: () => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !button.current || !popup.current) return;
    const r = button.current.getBoundingClientRect();
    placeFixed(popup.current, r.left, r.bottom + 4);
    popup.current.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled), input")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // `composedPath`, not `e.target`: the latter is the shadow host when the
    // editor runs inside `<wolf-review>`.
    const outside = (e: PointerEvent) => {
      if (!eventInside(e, popup.current, button.current)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(popup.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(activeElement(e.currentTarget as Node) as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]!.focus();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        class="we-btn we-slides-menu-btn"
        data-testid={testid}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={pressed === undefined ? undefined : pressed}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {label}
        <Icon name="caret" />
      </button>
      {open && (
        <div
          ref={popup}
          class="we-menu we-slides-menu"
          role="menu"
          aria-label={label}
          data-testid={`${testid}-menu`}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

function Item({
  testid,
  label,
  title,
  shortcut,
  checked,
  disabled,
  onSelect,
}: {
  testid: string;
  label: string;
  title?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked === undefined ? undefined : checked}
      class="we-menu-item we-slides-menu-item"
      data-testid={testid}
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
    >
      <span>{label}</span>
      {shortcut && <kbd class="we-slides-kbd">{shortcut}</kbd>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/**
 * Cmd/Ctrl+V outside text entry: an image on the system clipboard becomes a
 * picture on the current slide, else copied shapes are pasted. In a shadow
 * root only pastes from inside it, or with nothing focused, are taken.
 */
function usePaste(host: EditorHost, anchor: { current: HTMLElement | null }) {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const store = storeOf(host);
      const snap = host.getSnapshot();
      if (snap.state?.format !== "pptx" || snap.busy || typing(e) || store.state.editing || store.state.show !== null)
        return;
      const root = anchor.current?.getRootNode();
      const origin = eventOrigin(e);
      if (
        root instanceof ShadowRoot &&
        !eventInside(e, root.host) &&
        origin !== document.body &&
        origin !== document.documentElement
      )
        return;
      const picture = [...(e.clipboardData?.files ?? [])].find(isPictureFile);
      if (picture) {
        e.preventDefault();
        void insertPictureFile(host, picture);
        return;
      }
      if (store.state.clipboard) {
        e.preventDefault();
        void pasteShapes(host);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [host]);
}

export function SlidesToolbar({ host }: PluginProps) {
  const snap = useEditor(host);
  const [ui, store] = useSlides(host);
  const bar = useRef<HTMLDivElement>(null);
  usePaste(host, bar);
  const state = snap.state;
  if (!state || state.format !== "pptx") return null;
  const busy = snap.busy;
  const targets = formatTargets(host);
  // Caret editing (reactor kernel) keeps formatting on: the engine formats
  // the edited shape or cell, and the text selection stays.
  const canFormat = targets.length > 0 && !busy && (!ui.editing || ui.editing.mode === "caret");
  const font = formatState(host, targets[0]);
  const shapes = selectedShapes(host);
  const focus = tableFocus(host);
  const slide = currentSlide(host);
  const format = (patch: FormatPatch, label: string) => void applyFormat(host, patch, label);
  const moveRefusal = ui.disabled["shape-move"];
  const resizeRefusal = ui.disabled["shape-resize"];

  const toggle = (key: "bold" | "italic" | "underline", label: string, text: string) => {
    const value = font[key];
    return (
      <button
        type="button"
        class={`we-btn we-btn--icon we-slides-${key}`}
        data-testid={`slides-${key}`}
        title={`${label} (Cmd+${text})${value === "mixed" ? ": mixed in this text" : ""}`}
        aria-label={label}
        aria-pressed={value === "mixed" ? "mixed" : value === true}
        disabled={!canFormat}
        onClick={() => void toggleFont(host, key)}
      >
        {text}
      </button>
    );
  };

  return (
    <div
      ref={bar}
      class="we-slides-toolbar"
      data-testid="slides-toolbar"
      role="toolbar"
      aria-label="Slides"
      onMouseDown={(e) => {
        // Buttons must not take focus from the caret editor's input.
        if (store.state.editing?.mode === "caret" && (eventOrigin(e) as Element | null)?.closest?.("button"))
          e.preventDefault();
      }}
    >
      <InsertMenu host={host} disabled={busy || !slide} />
      <span class="we-sep" />

      {toggle("bold", "Bold", "B")}
      {toggle("italic", "Italic", "I")}
      {toggle("underline", "Underline", "U")}
      <select
        class="we-select we-slides-select we-slides-font"
        data-testid="slides-font-name"
        title={font.name ? `Font: ${font.name}` : "Font (not set on this text, or mixed)"}
        aria-label="Font"
        disabled={!canFormat}
        value={font.name ?? ""}
        onChange={(e) => {
          const name = (e.currentTarget as HTMLSelectElement).value;
          if (name) format({ font: { name } }, `Font ${name}`);
        }}
      >
        <option value="">Font</option>
        {font.name && !FONTS.includes(font.name) && <option value={font.name}>{font.name}</option>}
        {FONTS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <select
        class="we-select we-slides-select"
        data-testid="slides-font-size"
        title={
          font.size !== undefined
            ? `Font size: ${font.size} pt`
            : "Font size in points (not set on this text, or mixed)"
        }
        aria-label="Font size"
        disabled={!canFormat}
        value={font.size !== undefined ? String(font.size) : ""}
        onChange={(e) => {
          const size = Number((e.currentTarget as HTMLSelectElement).value);
          if (size) format({ font: { size } }, `Font size ${size}`);
        }}
      >
        <option value="">Size</option>
        {font.size !== undefined && !SIZES.includes(font.size) && (
          <option value={String(font.size)}>{font.size}</option>
        )}
        {SIZES.map((s) => (
          <option key={s} value={String(s)}>
            {s}
          </option>
        ))}
      </select>
      <ColorInput
        testid="slides-font-color"
        icon="font-color"
        label="Text colour"
        value={font.color}
        disabled={!canFormat}
        onPick={(color) => format({ font: { color } }, "Text colour")}
      />
      <ColorInput
        testid="slides-fill-color"
        icon="fill"
        label="Fill colour"
        value={font.fill}
        disabled={!canFormat}
        onPick={(color) => format({ fill: { color } }, "Fill colour")}
      />
      <ColorInput
        testid="slides-line-color"
        icon="line"
        label="Line colour"
        value={font.line}
        disabled={!canFormat}
        onPick={(color) => format({ line: { color } }, "Line colour")}
      />
      <select
        class="we-select we-slides-select"
        data-testid="slides-line-width"
        title="Line width (points)"
        aria-label="Line width"
        disabled={!canFormat}
        value={font.lineWidth !== undefined ? String(font.lineWidth) : ""}
        onChange={(e) => {
          const width = Number((e.currentTarget as HTMLSelectElement).value);
          if (width) format({ line: { width } }, `Line ${width} pt`);
        }}
      >
        <option value="">Line</option>
        {font.lineWidth !== undefined && !LINE_WIDTHS.includes(font.lineWidth) && (
          <option value={String(font.lineWidth)}>{font.lineWidth} pt</option>
        )}
        {LINE_WIDTHS.map((w) => (
          <option key={w} value={String(w)}>
            {w} pt
          </option>
        ))}
      </select>
      <span class="we-sep" />

      {(["left", "center", "right", "justify"] as const).map((h) => (
        <IconButton
          key={h}
          testid={`slides-align-${h}`}
          icon={`text-${h}`}
          label={`Align text ${h}`}
          title={h === "justify" ? "Justify text" : `Align text ${h}`}
          disabled={!canFormat}
          pressed={font.horizontal === h}
          onClick={() => format({ alignment: { horizontal: h } }, `Align ${h}`)}
        />
      ))}
      {(["top", "center", "bottom"] as const).map((v) => (
        <IconButton
          key={v}
          testid={`slides-valign-${v}`}
          icon={`anchor-${v === "center" ? "middle" : v}`}
          label={`Vertical align ${v}`}
          title={`Anchor text ${v === "center" ? "in the middle" : `at the ${v}`}`}
          disabled={!canFormat}
          pressed={font.vertical === v}
          onClick={() => format({ alignment: { vertical: v } }, `Vertical ${v}`)}
        />
      ))}
      <span class="we-sep" />

      <ArrangeMenu host={host} disabled={busy || shapes.length === 0} />
      <IconButton
        testid="slides-duplicate"
        icon="duplicate"
        label="Duplicate shape"
        title="Duplicate shape (Cmd+D)"
        disabled={busy || shapes.length === 0}
        onClick={() => void duplicateShapes(host)}
      />
      <IconButton
        testid="slides-delete"
        icon="delete"
        label="Delete selection"
        title="Delete selection (Delete)"
        danger
        disabled={busy || snap.selection.length === 0}
        onClick={() => void deleteSelection(host)}
      />
      {focus && (
        <Menu testid="slides-table" label="Table" title="Table rows and columns" disabled={busy}>
          {(close) => {
            const run = (fn: () => Promise<void>) => () => {
              close();
              void fn();
            };
            return (
              <>
                <Item
                  testid="slides-row-above"
                  label="Insert row above"
                  onSelect={run(() => tableInsertRow(host, "before"))}
                />
                <Item
                  testid="slides-row-below"
                  label="Insert row below"
                  onSelect={run(() => tableInsertRow(host, "after"))}
                />
                <Item
                  testid="slides-row-delete"
                  label="Delete row"
                  disabled={(focus.table.table?.rows.length ?? 0) < 2}
                  onSelect={run(() => tableDeleteRow(host))}
                />
                <hr />
                <Item
                  testid="slides-col-left"
                  label="Insert column left"
                  onSelect={run(() => tableInsertColumn(host, "before"))}
                />
                <Item
                  testid="slides-col-right"
                  label="Insert column right"
                  onSelect={run(() => tableInsertColumn(host, "after"))}
                />
                <Item
                  testid="slides-col-delete"
                  label="Delete column"
                  disabled={(focus.table.table?.cols.length ?? 0) < 2}
                  onSelect={run(() => tableDeleteColumn(host))}
                />
              </>
            );
          }}
        </Menu>
      )}
      <span class="we-sep" />

      <SlideMenu host={host} disabled={busy || !slide} />
      <IconButton
        testid="slides-show"
        icon="show"
        label="Start slide show"
        title="Slide show from the current slide (F5)"
        disabled={!slide}
        onClick={() => store.set({ show: snap.currentPage, editing: null })}
      />
      {moveRefusal && (
        <span
          class="we-chip we-chip--danger"
          data-testid="slides-move-status"
          title={`Move refused by the engine (${moveRefusal.code}): ${moveRefusal.message}`}
        >
          Move off
        </span>
      )}
      {resizeRefusal && (
        <span
          class="we-chip we-chip--danger"
          data-testid="slides-resize-status"
          title={`Resize refused by the engine (${resizeRefusal.code}): ${resizeRefusal.message}`}
        >
          Resize off
        </span>
      )}

      {(ui.insert || ui.notice) && (
        <div class="we-slides-float">
          {ui.insert && (
            <div class="we-notice we-notice--info we-slides-notice" data-testid="slides-insert-hint">
              <span>Drag on the slide to place (click for default size, Esc cancels)</span>
            </div>
          )}
          {ui.notice && (
            <div
              class={`we-notice we-notice--${ui.notice.tone} we-slides-notice`}
              role={ui.notice.tone === "error" ? "alert" : "status"}
              data-testid="slides-notice"
            >
              <span>{ui.notice.text}</span>
              <button
                type="button"
                class="we-btn we-btn--small we-btn--outline"
                data-testid="slides-notice-dismiss"
                title="Dismiss"
                aria-label="Dismiss message"
                onClick={() => store.set({ notice: null })}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
      {ui.show !== null && <SlideShow host={host} start={ui.show} onClose={() => store.set({ show: null })} />}
    </div>
  );
}

const FILL_KIND_TEXT: Record<string, string> = {
  none: "none",
  gradient: "gradient",
  picture: "picture",
  pattern: "pattern",
  group: "group fill",
};

/** What a colour state reads as, for the tooltip and the swatch. */
function describeColor(
  value: ColorState | undefined,
): { text: string; swatch: "hex" | "theme" | "none" | "other" } | null {
  if (!value) return null;
  if (value.hex) return { text: value.hex, swatch: "hex" };
  // `scheme:accent1`, `system:windowText`, `preset:red`: the `format` op
  // writes `#RRGGBB` only, so these are shown, not offered.
  if (value.theme) return { text: `theme colour (${value.theme})`, swatch: "theme" };
  if (value.kind && value.kind !== "solid")
    return { text: FILL_KIND_TEXT[value.kind] ?? value.kind, swatch: value.kind === "none" ? "none" : "other" };
  return null;
}

/** Colour picker. `value` is the target's own colour from observe: a hex
 * colour is shown as a swatch and preselected; a theme/system/preset colour,
 * no fill or a non-solid fill is shown as such (tooltip and swatch), never as
 * unset. Absent = not set on the target (inherited) or mixed. */
function ColorInput({
  testid,
  icon,
  label,
  value,
  disabled,
  onPick,
}: {
  testid: string;
  icon: string;
  label: string;
  value?: ColorState;
  disabled: boolean;
  onPick: (hex: string) => void;
}) {
  const shown = describeColor(value);
  return (
    <label class={`we-slides-color${disabled ? " is-disabled" : ""}`} title={shown ? `${label}: ${shown.text}` : label}>
      <Icon name={icon} />
      {shown && (
        <span
          class={`we-slides-swatch we-slides-swatch-${shown.swatch}`}
          data-testid={`${testid}-swatch`}
          data-color={shown.swatch}
          style={shown.swatch === "hex" ? { background: value!.hex } : undefined}
        />
      )}
      <input
        type="color"
        data-testid={testid}
        aria-label={shown ? `${label}: ${shown.text}` : label}
        disabled={disabled}
        {...(value?.hex ? { value: value.hex.toLowerCase() } : {})}
        onChange={(e) => onPick((e.currentTarget as HTMLInputElement).value.toUpperCase())}
      />
    </label>
  );
}

function InsertMenu({ host, disabled }: { host: EditorHost; disabled: boolean }) {
  const [ui, store] = useSlides(host);
  const file = useRef<HTMLInputElement>(null);
  const pictureRefusal = ui.disabled["picture-insert"];
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const mode = ui.insert;
  const pick = (insert: typeof mode, close: () => void) => {
    store.set({ insert, editing: null });
    close();
  };
  const placing =
    mode?.kind === "textbox"
      ? "Text box"
      : mode?.kind === "table"
        ? `Table ${mode.rows}x${mode.cols}`
        : mode?.kind === "shape"
          ? SHAPE_GEOMETRIES.find((g) => g.geometry === mode.geometry)?.label
          : null;
  return (
    <>
      <input
        ref={file}
        type="file"
        hidden
        accept={PICTURE_TYPES.join(",")}
        data-testid="slides-picture-file"
        aria-label="Picture file"
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          const picked = input.files?.[0];
          input.value = "";
          if (picked) void insertPictureFile(host, picked);
        }}
      />
      <Menu
        testid="slides-insert"
        label="Insert"
        title={
          placing ? `Insert: placing ${placing} (drag on the slide)` : "Insert a text box, picture, shape or table"
        }
        pressed={!!mode}
        disabled={disabled}
      >
        {(close) => (
          <>
            <Item
              testid="slides-insert-textbox"
              label="Text box"
              title="Insert text box: drag on the slide"
              checked={mode?.kind === "textbox"}
              onSelect={() => pick({ kind: "textbox" }, close)}
            />
            <Item
              testid="slides-insert-picture"
              label="Picture..."
              title={
                pictureRefusal
                  ? `Insert picture refused by the engine (${pictureRefusal.code}): ${pictureRefusal.message}`
                  : "Insert a picture from a file (or drop / paste an image onto the slide)"
              }
              disabled={!!pictureRefusal}
              onSelect={() => {
                pick(null, close);
                file.current?.click();
              }}
            />
            <div class="we-slides-menu-title">Shape</div>
            <div class="we-slides-menu-grid">
              {SHAPE_GEOMETRIES.map((g) => (
                <Item
                  key={g.geometry}
                  testid={`slides-insert-shape-${g.geometry}`}
                  label={g.label}
                  title={`Insert ${g.label.toLowerCase()}: drag on the slide`}
                  checked={mode?.kind === "shape" && mode.geometry === g.geometry}
                  onSelect={() => pick({ kind: "shape", geometry: g.geometry }, close)}
                />
              ))}
            </div>
            <div class="we-slides-menu-title">Table</div>
            <div class="we-slides-table-insert">
              <input
                class="we-input"
                type="number"
                min={1}
                max={1000}
                value={rows}
                data-testid="slides-table-rows"
                title="Table rows"
                aria-label="Table rows"
                onInput={(e) =>
                  setRows(Math.max(1, Math.min(1000, Number((e.currentTarget as HTMLInputElement).value) || 1)))
                }
              />
              x
              <input
                class="we-input"
                type="number"
                min={1}
                max={63}
                value={cols}
                data-testid="slides-table-cols"
                title="Table columns"
                aria-label="Table columns"
                onInput={(e) =>
                  setCols(Math.max(1, Math.min(63, Number((e.currentTarget as HTMLInputElement).value) || 1)))
                }
              />
              <Item
                testid="slides-insert-table"
                label="Insert table"
                title="Insert table: drag on the slide"
                checked={mode?.kind === "table"}
                onSelect={() => pick({ kind: "table", rows, cols }, close)}
              />
            </div>
            {mode && (
              <>
                <hr />
                <Item
                  testid="slides-insert-cancel"
                  label="Cancel placing"
                  shortcut="Esc"
                  onSelect={() => pick(null, close)}
                />
              </>
            )}
          </>
        )}
      </Menu>
    </>
  );
}

const ALIGN_ITEMS: { edge: AlignEdge; label: string }[] = [
  { edge: "left", label: "Align left" },
  { edge: "center", label: "Align centre" },
  { edge: "right", label: "Align right" },
  { edge: "top", label: "Align top" },
  { edge: "middle", label: "Align middle" },
  { edge: "bottom", label: "Align bottom" },
];

function ArrangeMenu({ host, disabled }: { host: EditorHost; disabled: boolean }) {
  const [ui] = useSlides(host);
  const shapes = selectedShapes(host);
  const move = ui.disabled["shape-move"];
  const orderRefusal = ui.disabled["shape-order"];
  const one = shapes.length === 1;
  return (
    <Menu testid="slides-arrange" label="Arrange" title="Order, align and distribute shapes" disabled={disabled}>
      {(close) => {
        const run = (fn: () => Promise<void>) => () => {
          close();
          void fn();
        };
        return (
          <>
            <div class="we-slides-menu-title">Order</div>
            <Item
              testid="slides-front"
              label="Bring to front"
              title={orderRefusal ? "Bring to front (re-inserts the shape on top; it gets a new id)" : "Bring to front"}
              onSelect={run(() => restackShapes(host, "front"))}
            />
            <Item
              testid="slides-forward"
              label="Bring forward"
              title={
                orderRefusal
                  ? `Bring forward refused by the engine (${orderRefusal.code}): ${orderRefusal.message}`
                  : "Bring forward one step"
              }
              disabled={!!orderRefusal || shapes.length !== 1}
              onSelect={run(() => stepShapes(host, "forward"))}
            />
            <Item
              testid="slides-backward"
              label="Send backward"
              title={
                orderRefusal
                  ? `Send backward refused by the engine (${orderRefusal.code}): ${orderRefusal.message}`
                  : "Send backward one step"
              }
              disabled={!!orderRefusal || shapes.length !== 1}
              onSelect={run(() => stepShapes(host, "backward"))}
            />
            <Item
              testid="slides-back"
              label="Send to back"
              title={
                orderRefusal ? "Send to back (re-inserts the shape at the bottom; it gets a new id)" : "Send to back"
              }
              onSelect={run(() => restackShapes(host, "back"))}
            />
            <hr />
            <div class="we-slides-menu-title">{one ? "Align to slide" : "Align selected shapes"}</div>
            {ALIGN_ITEMS.map((a) => (
              <Item
                key={a.edge}
                testid={`slides-arrange-${a.edge}`}
                label={a.label}
                title={move ? `Needs shape move, refused by the engine (${move.code})` : a.label}
                disabled={!!move}
                onSelect={run(() => alignShapes(host, a.edge))}
              />
            ))}
            <hr />
            <Item
              testid="slides-distribute-h"
              label="Distribute horizontally"
              title={
                move
                  ? `Needs shape move, refused by the engine (${move.code})`
                  : "Equal horizontal gaps (three or more shapes)"
              }
              disabled={!!move || shapes.length < 3}
              onSelect={run(() => distributeShapes(host, "horizontal"))}
            />
            <Item
              testid="slides-distribute-v"
              label="Distribute vertically"
              title={
                move
                  ? `Needs shape move, refused by the engine (${move.code})`
                  : "Equal vertical gaps (three or more shapes)"
              }
              disabled={!!move || shapes.length < 3}
              onSelect={run(() => distributeShapes(host, "vertical"))}
            />
            {move && (
              <div class="we-slides-menu-note" data-testid="slides-arrange-refused">
                Align and distribute are off: the engine refused shape move ({move.code}).
              </div>
            )}
          </>
        );
      }}
    </Menu>
  );
}

function SlideMenu({ host, disabled }: { host: EditorHost; disabled: boolean }) {
  const snap = useEditor(host);
  const [, store] = useSlides(host);
  const d = deck(host);
  const slide = currentSlide(host);
  if (!d || !slide)
    return (
      <Menu testid="slides-slide-actions" label="Slide" title="Slide operations" disabled>
        {() => null}
      </Menu>
    );
  const index = d.slides.indexOf(slide);
  return (
    <Menu testid="slides-slide-actions" label="Slide" title="Slide operations" disabled={disabled}>
      {(close) => {
        const run = (fn: () => Promise<void>) => () => {
          close();
          void fn();
        };
        return (
          <>
            <Item
              testid="slides-slide-new"
              label="New slide"
              title="New slide after this one, same layout"
              onSelect={run(() => addSlide(host, slide.id))}
            />
            <Item
              testid="slides-slide-duplicate"
              label="Duplicate slide"
              onSelect={run(() => duplicateSlideCmd(host, slide.id))}
            />
            <Item
              testid="slides-slide-up"
              label="Move slide up"
              disabled={index <= 0}
              onSelect={run(() => moveSlideTo(host, slide.id, index - 1))}
            />
            <Item
              testid="slides-slide-down"
              label="Move slide down"
              disabled={index >= d.slides.length - 1}
              onSelect={run(() => moveSlideTo(host, slide.id, index + 1))}
            />
            <Item
              testid="slides-slide-delete"
              label="Delete slide"
              disabled={d.slides.length < 2}
              onSelect={run(() => deleteSlide(host, slide.id))}
            />
            <hr />
            <Item
              testid="slides-show-start"
              label="Slide show from start"
              onSelect={() => {
                close();
                store.set({ show: 1, editing: null });
              }}
            />
            <Item
              testid="slides-show-current"
              label="Slide show from current"
              shortcut="F5"
              onSelect={() => {
                close();
                store.set({ show: snap.currentPage, editing: null });
              }}
            />
          </>
        );
      }}
    </Menu>
  );
}
