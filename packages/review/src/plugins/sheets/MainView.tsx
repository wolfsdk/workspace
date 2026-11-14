/**
 * Main view of an XLSX document: name box and formula bar, the link bar
 * (Insert link / Cmd+K), status banners (refusals, read failures,
 * uncalculated workbook with Recalculate, truncated view), and either the
 * editable grid or the engine's print render of the active sheet.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { PageInfo } from "@wolfsdk/protocol";
import type { EditorHost } from "../../host/index.ts";
import { Grid } from "./Grid.tsx";
import { BAR_KEYS, dispatch } from "./keys.ts";
import { linkInputText } from "./links.ts";
import { editText, sheetIdOf } from "./model.ts";
import { toA1 } from "./refs.ts";
import { useSheets, type SheetsStore } from "./store.ts";

export function SheetsMainView({ host }: { host: EditorHost }) {
  const store = useSheets(host);
  const state = host.getSnapshot().state;
  if (!state || state.format !== "xlsx") return null;
  const at = store.linkDialog;
  return (
    <div class="we-sheets-main" data-testid="sheets-main">
      <FormulaBar store={store} />
      {at && <LinkBar key={`${at.sheetId}:${at.row}:${at.col}`} store={store} />}
      <Banners store={store} />
      {store.view === "grid" ? <Grid host={host} /> : <PrintPreview store={store} />}
    </div>
  );
}

/** Insert or edit the link of one cell: a web or mailto address, or a
 * place in the workbook (`Sheet1!A1`), plus an optional tooltip. */
function LinkBar({ store }: { store: SheetsStore }) {
  const at = store.linkDialog!;
  const sheet = store.model?.byId.get(at.sheetId);
  const current = sheet ? store.linkAt(sheet, at.row, at.col) : null;
  const editable = current && current.source !== "formula" ? current : null;
  const [address, setAddress] = useState(linkInputText(editable));
  const [tooltip, setTooltip] = useState(editable?.tooltip ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const cell = `${sheet?.name ?? ""}!${toA1(at.row, at.col)}`;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const problem = await store.saveLink(address, tooltip);
    setBusy(false);
    setError(problem);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      store.closeLinkDialog();
    }
  };
  return (
    <div class="we-sheets-linkbar" role="dialog" aria-label={`Link for ${cell}`} data-testid="sheets-link-dialog">
      <span class="we-sheets-linkbar-label">Link for {cell}</span>
      <input
        ref={ref}
        class="we-input we-sheets-linkbar-input"
        data-testid="sheets-link-address"
        aria-label="Link address"
        title="A web address (https://...), an email address, or a place in this workbook such as Sheet1!A1"
        placeholder="https://example.com, name@example.com or Sheet1!A1"
        spellcheck={false}
        value={address}
        onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
      />
      <input
        class="we-input we-sheets-linkbar-tip"
        data-testid="sheets-link-tooltip"
        aria-label="Link tooltip"
        title="Optional text shown when hovering the link in Excel"
        placeholder="Tooltip (optional)"
        value={tooltip}
        onInput={(e) => setTooltip((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        class="we-btn we-btn--small we-btn--primary"
        data-testid="sheets-link-apply"
        title="Set this link (Enter)"
        aria-label="Set link"
        disabled={busy}
        onClick={() => void save()}
      >
        {editable ? "Update link" : "Insert link"}
      </button>
      {editable && (
        <button
          type="button"
          class="we-btn we-btn--small we-btn--danger-quiet"
          data-testid="sheets-link-remove"
          title="Remove the link from this cell (the text stays)"
          aria-label="Remove link"
          disabled={busy}
          onClick={() => {
            store.closeLinkDialog();
            store.removeLink();
          }}
        >
          Remove link
        </button>
      )}
      <button
        type="button"
        class="we-btn we-btn--small we-btn--outline"
        data-testid="sheets-link-cancel"
        title="Close without changes (Escape)"
        aria-label="Cancel"
        onClick={() => store.closeLinkDialog()}
      >
        Cancel
      </button>
      {error && (
        <span class="we-sheets-linkbar-error" role="alert" data-testid="sheets-link-error">
          {error}
        </span>
      )}
    </div>
  );
}

function NameBox({ store }: { store: SheetsStore }) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = store.selectionLabel;
  return (
    <input
      class="we-input we-sheets-namebox"
      data-testid="sheets-namebox"
      aria-label="Name box: go to a cell or range"
      title="Go to a cell or range, for example B2, A1:C3 or Sheet2!C5"
      spellcheck={false}
      value={draft ?? label}
      onFocus={(e) => {
        const el = e.target as HTMLInputElement;
        setDraft(label);
        requestAnimationFrame(() => el.select());
      }}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const text = (draft ?? "").trim();
          if (!text) return;
          if (store.goto(text)) setDraft(null);
          else
            store.setNotice({
              kind: "error",
              code: "sheets-bad-reference",
              text: `"${text}" is not a cell, range or sheet reference in this workbook`,
            });
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
          store.focusGrid();
        }
      }}
    />
  );
}

function FormulaBar({ store }: { store: SheetsStore }) {
  const editing = store.editing;
  const sheet = store.sheet;
  const active = store.activeCell;
  const value = editing ? editing.text : editText(active);
  const ref = useRef<HTMLInputElement>(null);
  const disabled = store.isDisabled("edit");
  return (
    <div class="we-sheets-bar" data-testid="sheets-formula-bar">
      <NameBox store={store} />
      <span class="we-sheets-fx" aria-hidden="true">
        fx
      </span>
      <input
        ref={ref}
        class="we-input we-sheets-formula"
        data-testid="sheets-formula"
        aria-label="Cell contents"
        title={disabled ? `Editing refused by the engine (${disabled.code})` : "Value or formula of the active cell"}
        spellcheck={false}
        disabled={!sheet || !!disabled}
        value={value}
        onFocus={() => {
          if (!store.editing) store.beginEdit(null, "bar");
          else if (store.editing.source !== "bar") store.editing = { ...store.editing, source: "bar" };
        }}
        onInput={(e) => {
          const text = (e.target as HTMLInputElement).value;
          if (!store.editing) store.beginEdit(text, "bar");
          else store.setEditText(text);
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as HTMLElement | null;
          if (next?.classList.contains("we-sheets-editor")) return;
          if (store.editing?.source === "bar") store.commitEdit(null);
        }}
        onKeyDown={(e) => {
          if (dispatch(BAR_KEYS, { store, event: e })) e.preventDefault();
        }}
      />
      <div class="we-sheets-viewtoggle" role="group" aria-label="View">
        <button
          type="button"
          class="we-btn we-btn--small"
          data-testid="sheets-view-grid"
          title="Edit cells in the grid"
          aria-label="Grid view"
          aria-pressed={store.view === "grid"}
          onClick={() => store.setView("grid")}
        >
          Grid
        </button>
        <button
          type="button"
          class="we-btn we-btn--small"
          data-testid="sheets-view-print"
          title="Show the engine's print render of this sheet"
          aria-label="Print preview"
          aria-pressed={store.view === "print"}
          onClick={() => store.setView("print")}
        >
          Print preview
        </button>
      </div>
    </div>
  );
}

function Banners({ store }: { store: SheetsStore }) {
  const notice = store.notice;
  const readError = store.readError;
  const state = store.state;
  const uncalculated = store.uncalculated.length;
  const recalcRefused = store.isDisabled("recalc");
  const loaded = state ? (store.loadedRanges.get(state.sha256) ?? []) : [];
  const unaligned = store.display.unaligned;
  return (
    <>
      {notice && (
        <div
          class={`we-notice we-notice--${notice.kind} we-sheets-banner`}
          role={notice.kind === "error" ? "alert" : "status"}
          data-testid="sheets-notice"
          data-code={notice.code}
        >
          <span>
            {notice.code && (
              <code class={`we-chip we-chip--${notice.kind === "error" ? "danger" : "info"} we-sheets-code`}>
                {notice.code}
              </code>
            )}{" "}
            {notice.text}
          </span>
          <button
            type="button"
            class="we-btn we-btn--small"
            data-testid="sheets-notice-dismiss"
            title="Dismiss"
            aria-label="Dismiss message"
            onClick={() => store.setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {readError && (
        <div
          class="we-notice we-notice--error we-sheets-banner"
          role="alert"
          data-testid="sheets-read-error"
          data-code={readError.code}
        >
          <span>
            <code class="we-chip we-chip--danger we-sheets-code">{readError.code}</code> Display strings and merged
            cells could not be read from the engine: {readError.message}
          </span>
        </div>
      )}
      {uncalculated > 0 && (
        <div class="we-notice we-notice--info we-sheets-banner" role="status" data-testid="sheets-calc-banner">
          <span>
            {uncalculated} {uncalculated === 1 ? "formula has" : "formulas have"} no saved result (the file was never
            calculated), so {uncalculated === 1 ? "it shows" : "they show"} empty.{" "}
            {recalcRefused
              ? `This engine module cannot recalculate the workbook (${recalcRefused.code}); editing a cell they depend on recalculates them, and the print preview shows computed values.`
              : "Recalculate computes and stores every formula result."}
          </span>
          {!recalcRefused && (
            <button
              type="button"
              class="we-btn we-btn--small we-btn--outline"
              data-testid="sheets-recalc"
              title="Evaluate every formula in the workbook and store the results"
              aria-label="Recalculate workbook"
              onClick={() => store.recalculate()}
            >
              Recalculate
            </button>
          )}
        </div>
      )}
      {state?.truncated && (
        <div class="we-notice we-notice--info we-sheets-banner" role="status" data-testid="sheets-truncated">
          <span>
            Large workbook: the engine's view was cut at its node limit. Cells are loaded per screen as you scroll (
            {loaded.length} {loaded.length === 1 ? "block" : "blocks"} loaded for this revision).
          </span>
        </div>
      )}
      {unaligned.length > 0 && (
        <div class="we-notice we-notice--info we-sheets-banner" role="status" data-testid="sheets-unaligned">
          <span>
            Number formats could not be matched for {unaligned.join(", ")}; those numbers are shown unformatted.
          </span>
        </div>
      )}
    </>
  );
}

/** Pages of the engine's print render that show the active sheet. */
function sheetPages(store: SheetsStore): PageInfo[] {
  const state = store.state;
  const sheet = store.sheet;
  const model = store.model;
  if (!state || !sheet || !model) return [];
  const pages = new Set<number>();
  for (const r of state.regions) {
    const owner = sheetIdOf(r.object_id) ?? model.ownerOf.get(r.object_id);
    if (owner === sheet.sheetId) pages.add(r.page);
  }
  return state.pages.filter((p) => pages.has(p.page));
}

function PrintPreview({ store }: { store: SheetsStore }) {
  const host = store.host;
  const zoom = host.getSnapshot().zoom;
  const pages = sheetPages(store);
  const sheet = store.sheet;
  if (pages.length === 0) {
    return (
      <div class="we-sheets-print we-sheets-print-empty" data-testid="sheets-print-empty">
        The engine's print render has no page for sheet "{sheet?.name}" (an empty sheet or one outside the print area
        prints nothing).
      </div>
    );
  }
  return (
    <div class="we-sheets-print" data-testid="sheets-print">
      {pages.map((p) => (
        <PrintPage key={p.page} store={store} page={p} zoom={zoom} />
      ))}
    </div>
  );
}

function PrintPage({ store, page, zoom }: { store: SheetsStore; page: PageInfo; zoom: number }) {
  const host = store.host;
  const sha = store.state?.sha256;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scale = zoom * (globalThis.devicePixelRatio || 1);
  useEffect(() => {
    let live = true;
    setError(null);
    host.pageImageUrl(page.page, scale).then(
      (u) => live && setUrl(u),
      (cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      live = false;
    };
  }, [host, page.page, scale, sha]);
  const w = page.widthPt * zoom;
  const h = page.heightPt * zoom;
  return (
    <figure class="we-sheets-page" style={{ width: `${w}px` }} data-testid={`sheets-print-page-${page.page}`}>
      {error ? (
        <div class="we-notice we-notice--error we-sheets-page-error" role="alert" style={{ height: `${h}px` }}>
          Page {page.page} could not be rendered: {error}
        </div>
      ) : url ? (
        <img src={url} width={w} height={h} alt={`Printed page ${page.page}`} />
      ) : (
        <div class="we-sheets-page-loading" style={{ height: `${h}px` }}>
          Rendering page {page.page}
        </div>
      )}
      <figcaption>Page {page.page}</figcaption>
    </figure>
  );
}
