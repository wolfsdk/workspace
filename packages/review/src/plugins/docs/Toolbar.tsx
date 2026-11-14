import type { PluginProps } from "../../host/index.ts";
import { useEditor } from "../../host/index.ts";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  addComment,
  alignParagraphs,
  applyHeading,
  applyStyle,
  deleteParagraphs,
  deleteRow,
  findMatches,
  formatCell,
  formatFont,
  indentParagraphs,
  deleteColumn,
  insertColumn,
  insertImageFile,
  insertLink,
  insertParagraphNear,
  insertRow,
  insertTable,
  knownFormat,
  moveParagraph,
  replaceAll,
  replaceOne,
  targetParas,
  toggleFont,
  toggleList,
  toggleUnderline,
} from "./actions.ts";
import { type Binding, closeFind, dispatch, type KeyContext, openCompose, openFind, SHORTCUTS } from "./shortcuts.ts";
import { useDocs, type Compose, type DocsStore } from "./store.ts";

const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
const FONT_NAMES = ["Aptos", "Arial", "Calibri", "Cambria", "Courier New", "Georgia", "Times New Roman", "Verdana"];
const HIGHLIGHTS = ["yellow", "green", "cyan", "magenta", "red", "blue", "lightGray", "darkGray", "none"];

/** Button that, with `keep`, does not take focus from the in-place editor (acts on its text selection). */
function Btn(props: {
  id: string;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  keep?: boolean;
  icon?: boolean;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      class={props.icon ? "we-btn we-btn--small we-btn--icon" : "we-btn we-btn--small"}
      data-testid={`docs-${props.id}`}
      title={props.title ?? props.label}
      aria-label={props.label}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      disabled={props.disabled}
      onMouseDown={props.keep ? (e) => e.preventDefault() : undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** 16 px line icons drawn with the text colour. */
function Icon({ d, children }: { d?: string; children?: ComponentChildren }) {
  return (
    <svg class="we-docs-svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {d && <path d={d} />}
      {children}
    </svg>
  );
}

const ALIGN_ICONS: Record<"left" | "center" | "right" | "justify", string> = {
  left: "M2 3h12M2 6.5h8M2 10h12M2 13.5h8",
  center: "M2 3h12M4 6.5h8M2 10h12M4 13.5h8",
  right: "M2 3h12M6 6.5h8M2 10h12M6 13.5h8",
  justify: "M2 3h12M2 6.5h12M2 10h12M2 13.5h12",
};

function refusedTitle(store: DocsStore, feature: string, label: string): string {
  const error = store.ui.disabled[feature];
  return error ? `${label}: refused by the engine (${error.code}) ${error.message}` : label;
}

/**
 * Drop-down menu of secondary controls. Items close it; a click outside or
 * Escape closes it too. The panel is a keeper so the in-place editor stays
 * open while a select inside it is used.
 */
function Menu(props: {
  id: string;
  label: string;
  title?: string;
  open: string | null;
  setOpen: (id: string | null) => void;
  active?: boolean;
  end?: boolean;
  children: ComponentChildren;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const open = props.open === props.id;
  // Layout effect: listeners must be live as soon as the menu shows (a deferred effect misses a quick Escape).
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      // composedPath: inside a shadow root a document listener sees the host element as the target.
      if (!wrap.current || !e.composedPath().includes(wrap.current)) props.setOpen(null);
    };
    // The menu button keeps focus where it was (the page or the in-place editor), so listen document-wide.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      props.setOpen(null);
      const el = wrap.current;
      // `document.activeElement` is the shadow host inside a shadow root; ask the menu's own root.
      const active = el ? (el.getRootNode() as Document | ShadowRoot).activeElement : null;
      if (el && active && el.contains(active)) el.querySelector<HTMLButtonElement>(".we-docs-menubtn")?.focus();
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div class="we-docs-menuwrap" ref={wrap}>
      <button
        type="button"
        class={`we-btn we-btn--small we-docs-menubtn${props.active ? " we-docs-menubtn--active" : ""}`}
        data-testid={`docs-menu-${props.id}`}
        title={props.title ?? props.label}
        aria-label={props.title ?? props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.setOpen(open ? null : props.id)}
      >
        {props.label}
        <span class="we-docs-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          class={props.end ? "we-menu we-docs-menu we-docs-menu-end" : "we-menu we-docs-menu"}
          role="menu"
          data-testid={`docs-menu-${props.id}-panel`}
          data-we-docs-keep
        >
          {props.children}
        </div>
      )}
    </div>
  );
}

function Item(props: {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  keep?: boolean;
  close: () => void;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      class="we-menu-item"
      data-testid={`docs-${props.id}`}
      title={props.title ?? props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onMouseDown={props.keep ? (e) => e.preventDefault() : undefined}
      onClick={() => {
        props.close();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

type FindContext = KeyContext & { go: (step: number) => void; enter: boolean };

/** The find bar's keys (it dispatches them; also the plugin's shortcut list). */
export const FIND_BAR_KEYS: readonly Binding<FindContext>[] = [
  {
    keys: "Enter",
    label: "Next match",
    group: "Find",
    when: "in the find field",
    run: ({ go, enter }) => enter && (go(1), true),
  },
  {
    keys: "Shift+Enter",
    label: "Previous match",
    group: "Find",
    when: "in the find field",
    run: ({ go, enter }) => enter && (go(-1), true),
  },
  { keys: "Escape", label: "Close find", group: "Find", when: "in the find bar", run: ({ store }) => closeFind(store) },
];

function FindBar({ store }: { store: DocsStore }) {
  const [, ui] = useDocs(store.host);
  const find = ui.find;
  const input = useRef<HTMLInputElement>(null);
  const model = store.model();
  const matches = findMatches(model, find.query);
  const index = matches.length === 0 ? 0 : Math.min(find.index, matches.length - 1);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [find.focus]);

  const show = (at: number) => {
    const match = matches[at];
    if (!match) return;
    store.host.select([match.para]);
    store.host.reveal({ address: match.para });
  };
  const go = (step: number) => {
    if (matches.length === 0) return;
    const next = (index + step + matches.length) % matches.length;
    store.set({ find: { ...store.ui.find, index: next } });
    show(next);
  };
  const keys = (e: KeyboardEvent, enter: boolean) => {
    e.stopPropagation();
    dispatch(FIND_BAR_KEYS, { store, event: e, go, enter });
  };

  return (
    <div class="we-docs-findbar" data-testid="docs-findbar" role="search">
      <input
        ref={input}
        class="we-input"
        data-testid="docs-find-input"
        aria-label="Find text (Enter next, Shift+Enter previous, Escape closes)"
        title="Find text (Enter next, Shift+Enter previous, Escape closes)"
        placeholder="Find"
        value={find.query}
        onInput={(e) => {
          const query = e.currentTarget.value;
          store.set({ find: { ...store.ui.find, query, index: 0 } });
          const first = findMatches(store.model(), query)[0];
          if (first) store.host.reveal({ address: first.para });
        }}
        onKeyDown={(e) => keys(e, true)}
      />
      <span class="we-docs-count" data-testid="docs-find-count">
        {find.query === "" ? "" : matches.length === 0 ? "No matches" : `${index + 1} of ${matches.length}`}
      </span>
      <Btn id="find-prev" label="Previous match (Shift+Enter)" onClick={() => go(-1)} disabled={matches.length === 0}>
        Prev
      </Btn>
      <Btn id="find-next" label="Next match (Enter)" onClick={() => go(1)} disabled={matches.length === 0}>
        Next
      </Btn>
      <input
        class="we-input"
        data-testid="docs-replace-input"
        aria-label="Replace with"
        title="Replace with"
        placeholder="Replace with"
        value={find.replace}
        onInput={(e) => store.set({ find: { ...store.ui.find, replace: e.currentTarget.value } })}
        onKeyDown={(e) => keys(e, false)}
      />
      <Btn
        id="replace-one"
        label="Replace this match"
        disabled={matches.length === 0}
        onClick={() => void replaceOne(store, matches[index]!, find.query, find.replace)}
      >
        Replace
      </Btn>
      <Btn
        id="replace-all"
        label="Replace all matches"
        disabled={matches.length === 0}
        onClick={() => void replaceAll(store, find.query, find.replace)}
      >
        Replace all
      </Btn>
      <Btn id="find-close" label="Close find (Escape)" onClick={() => closeFind(store)}>
        Close
      </Btn>
    </div>
  );
}

function ComposeRow({ store, mode, close }: { store: DocsStore; mode: Exclude<Compose, null>; close: () => void }) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("https://");
  const [tip, setTip] = useState("");
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), [mode]);
  const stop = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (mode === "comment") await addComment(store, text);
    else if (mode === "link") {
      const target = url.startsWith("#") ? { bookmark: url.slice(1) } : { url };
      await insertLink(store, text, target, tip);
    } else await insertTable(store, rows, cols);
    if (store.ui.notice?.kind !== "error") close();
  };
  return (
    <form class="we-docs-compose" data-testid={`docs-compose-${mode}`} onSubmit={submit} onKeyDown={stop}>
      {mode === "comment" && (
        <input
          ref={first}
          class="we-input we-docs-wide"
          data-testid="docs-comment-text"
          aria-label="Comment text"
          title="Comment text"
          placeholder="Comment on the selected paragraph"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      )}
      {mode === "link" && (
        <>
          <input
            ref={first}
            class="we-input"
            data-testid="docs-link-text"
            aria-label="Link text"
            title="Link text"
            placeholder="Link text"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <input
            class="we-input"
            data-testid="docs-link-url"
            aria-label="Link address (or #bookmark)"
            title="Link address (or #bookmark)"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
          <input
            class="we-input"
            data-testid="docs-link-tooltip"
            aria-label="Link tooltip"
            title="Link tooltip"
            placeholder="Tooltip (optional)"
            value={tip}
            onInput={(e) => setTip(e.currentTarget.value)}
          />
        </>
      )}
      {mode === "table" && (
        <>
          <label class="we-docs-label">
            Rows
            <input
              ref={first}
              type="number"
              min={1}
              max={50}
              class="we-input we-docs-num"
              data-testid="docs-table-rows"
              aria-label="Rows"
              title="Rows"
              value={rows}
              onInput={(e) => setRows(Math.max(1, Number(e.currentTarget.value) || 1))}
            />
          </label>
          <label class="we-docs-label">
            Columns
            <input
              type="number"
              min={1}
              max={20}
              class="we-input we-docs-num"
              data-testid="docs-table-cols"
              aria-label="Columns"
              title="Columns"
              value={cols}
              onInput={(e) => setCols(Math.max(1, Number(e.currentTarget.value) || 1))}
            />
          </label>
        </>
      )}
      <button
        type="submit"
        class="we-btn we-btn--small we-btn--primary"
        data-testid={`docs-compose-${mode}-ok`}
        title="Insert"
        aria-label="Insert"
      >
        {mode === "comment" ? "Add comment" : mode === "link" ? "Insert link" : "Insert table"}
      </button>
      <button
        type="button"
        class="we-btn we-btn--small"
        data-testid={`docs-compose-${mode}-cancel`}
        title="Cancel"
        aria-label="Cancel"
        onClick={close}
      >
        Cancel
      </button>
    </form>
  );
}

export function DocsToolbar({ host }: PluginProps) {
  const snapshot = useEditor(host);
  const [store, ui] = useDocs(host);
  const [menu, setMenu] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const state = snapshot.state;
  if (!state || state.format !== "docx") return null;

  const model = store.model();
  const paras = model ? targetParas(store, model) : [];
  const para = paras[0];
  const pkg = model?.pkg ?? null;
  const known = knownFormat(store, para);
  const styleId = known.style ?? para?.pkg?.style ?? pkg?.defaultStyle ?? "";
  const listKind = known.list ?? null;
  const inCell = !!para?.cell;
  const none = !para;
  const off = (feature: string) => ui.disabled[feature] !== undefined;
  // The picker offers styles that are neither hidden nor semi-hidden, plus the paragraph's own.
  const styles = pkg
    ? pkg.styles.filter((s) => !s.hidden || s.id === styleId).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  // Heading levels come from every paragraph style with an outline level (Word keeps Heading 2-9 semi-hidden until used).
  const headings = pkg
    ? [
        ...new Map(
          pkg.styles
            .filter((s) => s.heading !== null)
            .sort((a, b) => a.heading! - b.heading!)
            .map((s) => [s.heading, s]),
        ).values(),
      ]
    : [];
  const heading = pkg?.styles.find((s) => s.id === styleId)?.heading ?? 0;
  const font = (f: Parameters<typeof formatFont>[1], label: string, feature: string) =>
    void formatFont(store, f, label, feature);
  const close = () => setMenu(null);
  const compose = (mode: Compose) => openCompose(store, ui.compose === mode ? null : mode);
  const menuProps = { open: menu, setOpen: setMenu };
  const bold = `Bold (${SHORTCUTS.bold})`;
  const italic = `Italic (${SHORTCUTS.italic})`;
  const underline = `Underline (${SHORTCUTS.underline})`;
  const bullets = `Bulleted list (${SHORTCUTS.bullets})`;
  const numbered = `Numbered list (${SHORTCUTS.numbered})`;

  return (
    <div class="we-docs-toolbar" data-testid="docs-toolbar" role="toolbar" aria-label="Document editing">
      <div class="we-docs-row">
        <select
          class="we-select we-docs-style"
          data-testid="docs-style"
          data-we-docs-keep
          aria-label="Paragraph style"
          title="Paragraph style"
          disabled={none}
          value={styleId}
          onChange={(e) => void applyStyle(store, e.currentTarget.value)}
        >
          {!styles.some((s) => s.id === styleId) && <option value={styleId}>{styleId || "Style"}</option>}
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span class="we-sep" aria-hidden="true" />
        <select
          class="we-select we-docs-fontname"
          data-testid="docs-font-name"
          data-we-docs-keep
          aria-label="Font"
          title={refusedTitle(store, "name", "Font")}
          disabled={none || off("name")}
          value={known.name ?? ""}
          onChange={(e) => font({ name: e.currentTarget.value }, "Font", "name")}
        >
          <option value="" disabled>
            Font
          </option>
          {known.name && !FONT_NAMES.includes(known.name) && <option value={known.name}>{known.name}</option>}
          {FONT_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select
          class="we-select we-docs-fontsize"
          data-testid="docs-font-size"
          data-we-docs-keep
          aria-label="Font size"
          title={refusedTitle(store, "size", "Font size")}
          disabled={none || off("size")}
          value={known.size === undefined ? "" : String(known.size)}
          onChange={(e) => font({ size: Number(e.currentTarget.value) }, "Font size", "size")}
        >
          <option value="" disabled>
            Size
          </option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={String(s)}>
              {s}
            </option>
          ))}
        </select>
        <span class="we-sep" aria-hidden="true" />
        <div class="we-docs-group" role="group" aria-label="Character">
          <Btn
            id="bold"
            icon
            label={bold}
            title={refusedTitle(store, "bold", bold)}
            keep
            pressed={known.bold === true}
            disabled={none || off("bold")}
            onClick={() => void toggleFont(store, "bold")}
          >
            <b>B</b>
          </Btn>
          <Btn
            id="italic"
            icon
            label={italic}
            title={refusedTitle(store, "italic", italic)}
            keep
            pressed={known.italic === true}
            disabled={none || off("italic")}
            onClick={() => void toggleFont(store, "italic")}
          >
            <i>I</i>
          </Btn>
          <Btn
            id="underline"
            icon
            label={underline}
            title={refusedTitle(store, "underline", underline)}
            keep
            pressed={known.underline !== undefined && known.underline !== "none"}
            disabled={none || off("underline")}
            onClick={() => void toggleUnderline(store)}
          >
            <u>U</u>
          </Btn>
          <Btn
            id="strike"
            icon
            label="Strikethrough"
            title={refusedTitle(store, "strike", "Strikethrough")}
            keep
            pressed={known.strike === true}
            disabled={none || off("strike")}
            onClick={() => void toggleFont(store, "strike")}
          >
            <s>S</s>
          </Btn>
          <label class="we-docs-swatch" title={refusedTitle(store, "color", "Text colour")}>
            <input
              type="color"
              data-testid="docs-font-color"
              data-we-docs-keep
              aria-label="Text colour"
              title="Text colour"
              disabled={none || off("color")}
              value={known.color ? `#${known.color.replace(/^#/, "").toLowerCase()}` : "#000000"}
              onChange={(e) => font({ color: e.currentTarget.value.toUpperCase() }, "Text colour", "color")}
            />
          </label>
          <select
            class="we-select we-docs-highlight"
            data-testid="docs-highlight"
            data-we-docs-keep
            aria-label="Highlight"
            title={refusedTitle(store, "highlight", "Highlight")}
            disabled={none || off("highlight")}
            value={known.highlight ?? ""}
            onChange={(e) => font({ highlight: e.currentTarget.value }, "Highlight", "highlight")}
          >
            <option value="" disabled>
              Highlight
            </option>
            {HIGHLIGHTS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </div>
        <span class="we-sep" aria-hidden="true" />
        <div class="we-docs-group" role="group" aria-label="Alignment">
          {(["left", "center", "right", "justify"] as const).map((a) => (
            <Btn
              key={a}
              id={`align-${a}`}
              icon
              label={`Align ${a}`}
              title={refusedTitle(store, "align", `Align ${a}`)}
              keep
              pressed={known.alignment === a}
              disabled={none || off("align")}
              onClick={() => void alignParagraphs(store, a)}
            >
              <Icon d={ALIGN_ICONS[a]} />
            </Btn>
          ))}
        </div>
        <span class="we-sep" aria-hidden="true" />
        <div class="we-docs-group" role="group" aria-label="List">
          <Btn
            id="list-bullet"
            icon
            label={bullets}
            title={refusedTitle(store, "list", bullets)}
            keep
            pressed={listKind === "bullet"}
            disabled={none || off("list")}
            onClick={() => void toggleList(store, "bullet")}
          >
            <Icon d="M6 4h8M6 8h8M6 12h8">
              <circle cx="2.8" cy="4" r="1.1" class="we-docs-fill" />
              <circle cx="2.8" cy="8" r="1.1" class="we-docs-fill" />
              <circle cx="2.8" cy="12" r="1.1" class="we-docs-fill" />
            </Icon>
          </Btn>
          <Btn
            id="list-number"
            icon
            label={numbered}
            title={refusedTitle(store, "list", numbered)}
            keep
            pressed={listKind === "number"}
            disabled={none || off("list")}
            onClick={() => void toggleList(store, "number")}
          >
            <Icon d="M6 4h8M6 8h8M6 12h8M2 2.5l1-.5v3.5M1.8 7h1.7l-1.7 2.5h1.9M1.8 11h1.6l-.8 1 .8 1H1.8" />
          </Btn>
          <Btn
            id="outdent"
            icon
            label="Decrease indent or list level (Shift+Tab in a list)"
            title={refusedTitle(store, "indent", "Decrease indent or list level (Shift+Tab in a list)")}
            keep
            disabled={none || off("indent")}
            onClick={() => void indentParagraphs(store, -1)}
          >
            <Icon d="M2 3h12M7 6.5h7M7 10h7M2 13.5h12M5 6.2 2.5 8.2 5 10.2" />
          </Btn>
          <Btn
            id="indent"
            icon
            label="Increase indent or list level (Tab in a list)"
            title={refusedTitle(store, "indent", "Increase indent or list level (Tab in a list)")}
            keep
            disabled={none || off("indent")}
            onClick={() => void indentParagraphs(store, 1)}
          >
            <Icon d="M2 3h12M7 6.5h7M7 10h7M2 13.5h12M2.5 6.2 5 8.2 2.5 10.2" />
          </Btn>
        </div>
        <span class="we-sep" aria-hidden="true" />
        <Menu id="paragraph" label="Paragraph" title="Paragraph: heading level, insert, move, delete" {...menuProps}>
          <label class="we-docs-menulabel">
            Heading
            <select
              class="we-select"
              data-testid="docs-heading"
              data-we-docs-keep
              aria-label="Heading level"
              title="Heading level (Cmd/Ctrl+Alt+1 to 3)"
              disabled={none}
              value={String(heading)}
              onChange={(e) => {
                close();
                void applyHeading(store, Number(e.currentTarget.value));
              }}
            >
              <option value="0">Body text</option>
              {headings.map((s) => (
                <option key={s.id} value={String(s.heading)}>
                  Heading {s.heading}
                </option>
              ))}
            </select>
          </label>
          <hr class="we-docs-menusep" />
          <Item
            id="para-above"
            label="Insert paragraph above"
            disabled={none}
            close={close}
            onClick={() => void insertParagraphNear(store, "above")}
          >
            Insert paragraph above
          </Item>
          <Item
            id="para-below"
            label="Insert paragraph below"
            disabled={none}
            close={close}
            onClick={() => void insertParagraphNear(store, "below")}
          >
            Insert paragraph below
          </Item>
          <Item
            id="para-up"
            label="Move paragraph up"
            disabled={none}
            close={close}
            onClick={() => void moveParagraph(store, -1)}
          >
            Move up
          </Item>
          <Item
            id="para-down"
            label="Move paragraph down"
            disabled={none}
            close={close}
            onClick={() => void moveParagraph(store, 1)}
          >
            Move down
          </Item>
          <Item
            id="para-delete"
            label="Delete paragraph"
            disabled={none}
            close={close}
            onClick={() => void confirmDelete(store)}
          >
            Delete paragraph
          </Item>
        </Menu>
        <Menu id="insert" label="Insert" title="Insert a table, picture, link or comment" {...menuProps}>
          <Item id="table-insert" label="Insert table" disabled={none} close={close} onClick={() => compose("table")}>
            Table...
          </Item>
          <Item
            id="image-insert"
            label="Insert picture after the paragraph"
            disabled={none}
            close={close}
            onClick={() => imageInput.current?.click()}
          >
            Picture...
          </Item>
          <Item
            id="link-insert"
            label={`Insert hyperlink at the end of the paragraph (${SHORTCUTS.link})`}
            disabled={none}
            close={close}
            onClick={() => compose("link")}
          >
            Link... <kbd class="we-docs-kbd">{SHORTCUTS.link}</kbd>
          </Item>
          <Item
            id="comment-add"
            label={`Add comment (${SHORTCUTS.comment})`}
            disabled={none}
            close={close}
            onClick={() => compose("comment")}
          >
            Comment... <kbd class="we-docs-kbd">{SHORTCUTS.comment}</kbd>
          </Item>
        </Menu>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/bmp"
          class="we-docs-file"
          data-testid="docs-image-file"
          aria-label="Picture file"
          title="Picture file"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void insertImageFile(store, file);
          }}
        />
        <Menu
          id="table"
          label="Table"
          title={
            inCell ? "Table rows, columns and cells" : "Table rows, columns and cells (select a paragraph in a table)"
          }
          {...menuProps}
        >
          <Item
            id="row-above"
            label="Insert row above"
            disabled={!inCell}
            close={close}
            onClick={() => void insertRow(store, "above")}
          >
            Insert row above
          </Item>
          <Item
            id="row-below"
            label="Insert row below"
            disabled={!inCell}
            close={close}
            onClick={() => void insertRow(store, "below")}
          >
            Insert row below
          </Item>
          <Item
            id="row-delete"
            label="Delete row"
            disabled={!inCell}
            close={close}
            onClick={() => void deleteRow(store)}
          >
            Delete row
          </Item>
          <Item
            id="col-left"
            label="Insert column left"
            disabled={!inCell}
            close={close}
            onClick={() => void insertColumn(store, "left")}
          >
            Insert column left
          </Item>
          <Item
            id="col-right"
            label="Insert column right"
            disabled={!inCell}
            close={close}
            onClick={() => void insertColumn(store, "right")}
          >
            Insert column right
          </Item>
          <Item
            id="col-delete"
            label="Delete column"
            title={refusedTitle(store, "col-delete", "Delete column")}
            disabled={!inCell || off("col-delete")}
            close={close}
            onClick={() => void deleteColumn(store)}
          >
            Delete column
          </Item>
          <hr class="we-docs-menusep" />
          <label class="we-docs-menulabel">
            Cell alignment
            <select
              class="we-select"
              data-testid="docs-cell-align"
              aria-label="Cell alignment"
              title={refusedTitle(store, "cell", "Cell alignment")}
              disabled={!inCell || off("cell")}
              value=""
              onChange={(e) => {
                const v = e.currentTarget.value;
                close();
                if (v.startsWith("v-"))
                  void formatCell(
                    store,
                    { vertical_align: v.slice(2) as "top" | "center" | "bottom" },
                    "Cell vertical alignment",
                  );
                else void formatCell(store, { align: v as "left" | "center" | "right" | "both" }, "Cell alignment");
              }}
            >
              <option value="" disabled>
                Choose
              </option>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
              <option value="both">Justify</option>
              <option value="v-top">Top</option>
              <option value="v-center">Middle</option>
              <option value="v-bottom">Bottom</option>
            </select>
          </label>
          <label class="we-docs-menulabel we-docs-swatch" title={refusedTitle(store, "cell", "Cell shading")}>
            Cell shading
            <input
              type="color"
              data-testid="docs-cell-shading"
              aria-label="Cell shading"
              title="Cell shading"
              disabled={!inCell || off("cell")}
              value="#ffffff"
              onChange={(e) => {
                close();
                void formatCell(store, { shading: e.currentTarget.value.toUpperCase() }, "Cell shading");
              }}
            />
          </label>
          <Item
            id="cell-shading-clear"
            label="Clear cell shading"
            disabled={!inCell || off("cell")}
            close={close}
            onClick={() => void formatCell(store, { shading: "none" }, "Clear cell shading")}
          >
            Clear cell shading
          </Item>
        </Menu>
        <span class="we-sep" aria-hidden="true" />
        <Menu
          id="review"
          label="Review"
          title={ui.track ? "Review: tracking changes is on" : "Review: track changes and author name"}
          active={ui.track}
          end
          {...menuProps}
        >
          <label class="we-docs-menulabel" title="Record edits as tracked changes">
            <input
              type="checkbox"
              data-testid="docs-track"
              aria-label="Track changes"
              title="Track changes"
              checked={ui.track}
              onChange={(e) => store.set({ track: e.currentTarget.checked })}
            />
            Track changes
          </label>
          <label class="we-docs-menulabel">
            Author
            <input
              class="we-input"
              data-testid="docs-author"
              aria-label="Author name for comments and tracked changes"
              title="Author name for comments and tracked changes"
              value={ui.author}
              onInput={(e) => store.set({ author: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") e.stopPropagation();
              }}
            />
          </label>
        </Menu>
        <Btn
          id="find"
          label={`Find and replace (${SHORTCUTS.find})`}
          pressed={ui.find.open}
          onClick={() => (ui.find.open ? closeFind(store) : openFind(store))}
        >
          Find
        </Btn>
      </div>
      {ui.compose && (
        <ComposeRow key={ui.compose} store={store} mode={ui.compose} close={() => openCompose(store, null)} />
      )}
      {ui.find.open && <FindBar store={store} />}
      {ui.notice && (
        <div
          class={`we-notice we-notice--${ui.notice.kind} we-docs-notice`}
          data-testid="docs-notice"
          data-code={ui.notice.code ?? ""}
          role={ui.notice.kind === "error" ? "alert" : "status"}
        >
          {ui.notice.code && <code class="we-docs-code">{ui.notice.code}</code>}
          <span>{ui.notice.text}</span>
          <button
            type="button"
            class="we-btn we-btn--small we-docs-dismiss"
            data-testid="docs-notice-dismiss"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => store.set({ notice: null })}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Delete the selected paragraphs; asks first when more than one is selected. */
export function confirmDelete(store: DocsStore): Promise<unknown> {
  const count = store.host.getSnapshot().selection.length;
  if (count > 1 && !window.confirm(`Delete ${count} paragraphs?`)) return Promise.resolve(null);
  return deleteParagraphs(store);
}
