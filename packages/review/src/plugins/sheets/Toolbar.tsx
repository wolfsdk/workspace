/**
 * Sheets toolbar: cell formatting, number formats, borders, merge, freeze,
 * row/column structure and fill. Every control issues one batch through
 * the store; a control the engine module cannot run (`op-kind-mismatch`,
 * `op-not-implemented`, unknown op) is disabled for the session and its
 * title names the refusal code.
 */
import type { ComponentChildren } from "preact";
import type { EditorHost } from "../../host/index.ts";
import * as ops from "./ops.ts";
import { useSheets, type SheetsStore } from "./store.ts";

type BtnProps = {
  store: SheetsStore;
  control: string;
  label: string;
  title: string;
  onClick: () => void;
  pressed?: boolean;
  children: ComponentChildren;
};

function Btn({ store, control, label, title, onClick, pressed, children }: BtnProps) {
  const refused = store.isDisabled(control);
  return (
    <button
      type="button"
      class="we-btn we-btn--small"
      data-testid={`sheets-${control}`}
      data-refused={refused?.code}
      title={refused ? `${title}: refused by the engine (${refused.code}) ${refused.message}` : title}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={!store.sheet || !!refused}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onClick();
        store.focusGrid();
      }}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span class="we-sep" aria-hidden="true" />;
}

const NUMBER_LABELS: Record<ops.NumberFormatPreset, string> = {
  general: "General",
  number: "Number 1,234.00",
  currency: "Currency $1,234.00",
  percent: "Percent 12.00%",
  date: "Date 1/31/2026",
};

const BORDER_LABELS: Record<ops.BorderPreset, string> = {
  all: "All borders",
  outline: "Outside border",
  bottom: "Bottom border",
  none: "No borders",
};

export function SheetsToolbar({ host }: { host: EditorHost }) {
  const store = useSheets(host);
  const state = host.getSnapshot().state;
  if (!state || state.format !== "xlsx") return null;
  const style = store.activeStyle;
  const merged = store.mergeAt(store.selection.active.row, store.selection.active.col);
  const frozen = store.sheet ? store.layout(store.sheet).frozen : null;
  const numberRefused = store.isDisabled("number-format");
  const borderRefused = store.isDisabled("borders");
  const fontColorRefused = store.isDisabled("font-color");
  const fillRefused = store.isDisabled("fill-color");

  return (
    <div class="we-sheets-toolbar" role="toolbar" aria-label="Sheet formatting" data-testid="sheets-toolbar">
      <Btn
        store={store}
        control="bold"
        label="Bold"
        title="Bold (Cmd/Ctrl+B)"
        pressed={!!style.bold}
        onClick={() => store.format("bold", ops.bold(!style.bold), "Bold")}
      >
        <b>B</b>
      </Btn>
      <Btn
        store={store}
        control="italic"
        label="Italic"
        title="Italic (Cmd/Ctrl+I)"
        pressed={!!style.italic}
        onClick={() => store.format("italic", ops.italic(!style.italic), "Italic")}
      >
        <i>I</i>
      </Btn>
      <Btn
        store={store}
        control="underline"
        label="Underline"
        title="Underline"
        pressed={!!style.underline}
        onClick={() => store.format("underline", ops.underline(!style.underline), "Underline")}
      >
        <u>U</u>
      </Btn>
      <label
        class="we-sheets-color"
        title={fontColorRefused ? `Text color: refused by the engine (${fontColorRefused.code})` : "Text color"}
      >
        <span aria-hidden="true">A</span>
        <input
          type="color"
          data-testid="sheets-font-color"
          aria-label="Text color"
          disabled={!store.sheet || !!fontColorRefused}
          value={style.color ?? "#000000"}
          onChange={(e) =>
            store.format("font-color", ops.fontColor((e.target as HTMLInputElement).value), "Text color")
          }
        />
      </label>
      <label
        class="we-sheets-color"
        title={fillRefused ? `Fill color: refused by the engine (${fillRefused.code})` : "Fill color"}
      >
        <span aria-hidden="true">Fill</span>
        <input
          type="color"
          data-testid="sheets-fill-color"
          aria-label="Fill color"
          disabled={!store.sheet || !!fillRefused}
          value={style.fill ?? "#ffffff"}
          onChange={(e) =>
            store.format("fill-color", ops.fillColor((e.target as HTMLInputElement).value), "Fill color")
          }
        />
      </label>
      <Btn
        store={store}
        control="no-fill"
        label="No fill"
        title="Remove fill"
        onClick={() => store.format("no-fill", ops.fillColor(null), "No fill")}
      >
        No fill
      </Btn>
      <Sep />
      {(["left", "center", "right"] as const).map((h) => (
        <Btn
          key={h}
          store={store}
          control={`align-${h}`}
          label={`Align ${h}`}
          title={`Align ${h}`}
          pressed={style.halign === h}
          onClick={() => store.format(`align-${h}`, ops.hAlign(style.halign === h ? "general" : h), `Align ${h}`)}
        >
          {h === "left" ? "Left" : h === "center" ? "Center" : "Right"}
        </Btn>
      ))}
      <Btn
        store={store}
        control="wrap"
        label="Wrap text"
        title="Wrap text"
        pressed={!!style.wrap}
        onClick={() => store.format("wrap", ops.wrapText(!style.wrap), "Wrap text")}
      >
        Wrap
      </Btn>
      <Btn
        store={store}
        control="hyperlink"
        label="Insert link"
        title="Insert or edit the link of the active cell (Cmd+K / Ctrl+K)"
        onClick={() => store.openLinkDialog()}
      >
        Link
      </Btn>
      <Sep />
      <select
        class="we-select"
        data-testid="sheets-number-format"
        aria-label="Number format"
        title={numberRefused ? `Number format: refused by the engine (${numberRefused.code})` : "Number format"}
        disabled={!store.sheet || !!numberRefused}
        value=""
        onChange={(e) => {
          const preset = (e.target as HTMLSelectElement).value as ops.NumberFormatPreset;
          (e.target as HTMLSelectElement).value = "";
          if (preset)
            store.format("number-format", ops.numberFormat(preset), `Number format: ${NUMBER_LABELS[preset]}`);
          store.focusGrid();
        }}
      >
        <option value="" disabled>
          Number format
        </option>
        {(Object.keys(NUMBER_LABELS) as ops.NumberFormatPreset[]).map((k) => (
          <option key={k} value={k} data-testid={`sheets-number-format-${k}`}>
            {NUMBER_LABELS[k]}
          </option>
        ))}
      </select>
      <select
        class="we-select"
        data-testid="sheets-borders"
        aria-label="Borders"
        title={borderRefused ? `Borders: refused by the engine (${borderRefused.code})` : "Borders"}
        disabled={!store.sheet || !!borderRefused}
        value=""
        onChange={(e) => {
          const preset = (e.target as HTMLSelectElement).value as ops.BorderPreset;
          (e.target as HTMLSelectElement).value = "";
          if (preset) store.format("borders", ops.borders(preset), BORDER_LABELS[preset]);
          store.focusGrid();
        }}
      >
        <option value="" disabled>
          Borders
        </option>
        {(Object.keys(BORDER_LABELS) as ops.BorderPreset[]).map((k) => (
          <option key={k} value={k}>
            {BORDER_LABELS[k]}
          </option>
        ))}
      </select>
      <Sep />
      {merged ? (
        <Btn
          store={store}
          control="unmerge"
          label="Unmerge cells"
          title="Unmerge cells"
          onClick={() => store.unmergeSelection()}
        >
          Unmerge
        </Btn>
      ) : (
        <Btn
          store={store}
          control="merge"
          label="Merge cells"
          title="Merge the selected cells"
          onClick={() => void store.mergeSelection()}
        >
          Merge
        </Btn>
      )}
      {frozen ? (
        <Btn
          store={store}
          control="unfreeze"
          label="Unfreeze panes"
          title="Unfreeze panes"
          onClick={() => store.unfreeze()}
        >
          Unfreeze
        </Btn>
      ) : (
        <Btn
          store={store}
          control="freeze"
          label="Freeze panes"
          title="Freeze rows above and columns left of the active cell"
          onClick={() => store.freezeAtSelection()}
        >
          Freeze
        </Btn>
      )}
      <Sep />
      <Btn
        store={store}
        control="insert-rows-above"
        label="Insert rows above"
        title="Insert rows above the selection"
        onClick={() => store.insertRows("above")}
      >
        +Row above
      </Btn>
      <Btn
        store={store}
        control="insert-rows-below"
        label="Insert rows below"
        title="Insert rows below the selection"
        onClick={() => store.insertRows("below")}
      >
        +Row below
      </Btn>
      <Btn
        store={store}
        control="insert-cols-left"
        label="Insert columns left"
        title="Insert columns left of the selection"
        onClick={() => store.insertCols("left")}
      >
        +Col left
      </Btn>
      <Btn
        store={store}
        control="insert-cols-right"
        label="Insert columns right"
        title="Insert columns right of the selection"
        onClick={() => store.insertCols("right")}
      >
        +Col right
      </Btn>
      <Btn
        store={store}
        control="delete-rows"
        label="Delete rows"
        title="Delete the selected rows"
        onClick={() => store.deleteRows()}
      >
        -Rows
      </Btn>
      <Btn
        store={store}
        control="delete-cols"
        label="Delete columns"
        title="Delete the selected columns"
        onClick={() => store.deleteCols()}
      >
        -Cols
      </Btn>
      <Sep />
      <Btn
        store={store}
        control="fill-down"
        label="Fill down"
        title="Fill down (Cmd/Ctrl+D)"
        onClick={() => store.fill("down")}
      >
        Fill down
      </Btn>
      <Btn
        store={store}
        control="fill-right"
        label="Fill right"
        title="Fill right (Cmd/Ctrl+R)"
        onClick={() => store.fill("right")}
      >
        Fill right
      </Btn>
      <Sep />
      <Btn
        store={store}
        control="sort-asc"
        label="Sort A to Z"
        title="Sort A to Z by the active cell's column"
        onClick={() => store.sortSelection("ascending")}
      >
        Sort A-Z
      </Btn>
      <Btn
        store={store}
        control="sort-desc"
        label="Sort Z to A"
        title="Sort Z to A by the active cell's column"
        onClick={() => store.sortSelection("descending")}
      >
        Sort Z-A
      </Btn>
    </div>
  );
}
