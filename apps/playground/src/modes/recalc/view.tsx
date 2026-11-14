/** @jsxImportSource preact */
/**
 * Presentational parts of the Recalc mode. They take everything as props so
 * tests can render them without an engine or a DOM.
 */
import { type Region, TID } from "../../lab/index.ts";
import {
  formatAbsolute,
  formatRelative,
  KIND_LABEL,
  nextSort,
  type RecalcAccess,
  type RecalcRow,
  recalcRows,
  regionFor,
  type ShownValue,
  type SortKey,
  type SortOrder,
  sortRows,
} from "./model.ts";
import type { RecalcRun } from "./store.ts";

export type StageImage =
  | { phase: "loading" }
  | { phase: "ready"; url: string; widthPt: number; heightPt: number; regions: Region[] }
  | { phase: "error"; code: string; message: string };

const COMPARE = "compare each stored value with Wolf's computed value";

function cellCount(n: number): string {
  return n === 1 ? "1 cell" : `${n} cells`;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export type StageViewProps = {
  access: RecalcAccess;
  run: RecalcRun;
  docName: string;
  page: number;
  pageCount: number;
  image: StageImage;
  onRun: () => void;
  onPage: (page: number) => void;
};

export function RecalcStageView(props: StageViewProps) {
  const { access, run } = props;
  const canRun = access.kind === "workbook";
  return (
    <div class="recalc">
      <div class="recalc-bar">
        <AccessNotice access={access} />
        {canRun && (
          <button
            type="button"
            class="recalc-run"
            data-testid={TID.recalcRun}
            data-state={run.phase}
            disabled={run.phase === "running"}
            onClick={props.onRun}
          >
            {run.phase === "running" ? "Recalculating" : "Recalculate"}
          </button>
        )}
      </div>
      {canRun && <StageResult run={run} />}
      {canRun && <SheetPage {...props} />}
    </div>
  );
}

function AccessNotice({ access }: { access: RecalcAccess }) {
  switch (access.kind) {
    case "workbook":
      return (
        <p class="recalc-lede">
          This is the sheet as a reader sees it, drawn from the values stored in the file. Press Recalculate to{" "}
          {COMPARE}.
        </p>
      );
    case "not-a-workbook":
      return (
        <p class="recalc-lede">
          Recalc works on workbooks. This file is a {access.format.toUpperCase()} file: drop an .xlsx file to use it.
        </p>
      );
  }
}

function StageResult({ run }: { run: RecalcRun }) {
  if (run.phase === "error") {
    return (
      <div class="recalc-error" role="alert" data-testid={TID.errorPanel} data-code={run.code}>
        Wolf could not recalculate this workbook: {run.message}
      </div>
    );
  }
  let body = null;
  if (run.phase === "running") body = <p>Recalculating.</p>;
  else if (run.phase === "unavailable") {
    body = <p class="recalc-notice">Wolf did not check this workbook: {run.reason}.</p>;
  } else if (run.phase === "done") {
    const rows = recalcRows(run.report);
    const from = "Result from the engine in this tab.";
    if (rows.length === 0) {
      body = (
        <p class="recalc-result recalc-result--clean">
          <strong data-testid={TID.recalcCount}>0</strong> cells differ. Every stored value matches Wolf's computed
          value. <span class="recalc-source">{from}</span>
        </p>
      );
    } else {
      body = (
        <p class="recalc-result">
          <strong data-testid={TID.recalcCount}>{rows.length}</strong>{" "}
          {rows.length === 1 ? "cell has a stored value" : "cells have a stored value"} that differs from Wolf's
          computed value. <span class="recalc-source">{from}</span>
        </p>
      );
    }
  }
  return (
    <div class="recalc-status" aria-live="polite">
      {body}
    </div>
  );
}

function SheetPage(props: StageViewProps) {
  const { image, page, pageCount } = props;
  const rows = props.run.phase === "done" ? recalcRows(props.run.report) : [];
  return (
    <figure class="recalc-sheet">
      {pageCount > 1 && (
        <div class="recalc-pages">
          <button type="button" disabled={page <= 1} onClick={() => props.onPage(page - 1)}>
            Previous page
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button type="button" disabled={page >= pageCount} onClick={() => props.onPage(page + 1)}>
            Next page
          </button>
        </div>
      )}
      {image.phase === "loading" && <p class="recalc-placeholder">Drawing the page.</p>}
      {image.phase === "error" && (
        <p class="recalc-placeholder" data-code={image.code}>
          The page could not be drawn: {image.message}
        </p>
      )}
      {image.phase === "ready" && <SheetImage image={image} rows={rows} alt={`Page ${page} of ${props.docName}`} />}
      <figcaption>
        Page {page} of {props.docName} as a reader sees it, drawn from the stored values.
        {image.phase === "ready" && rows.length > 0 && <OffPage rows={rows} regions={image.regions} />}
      </figcaption>
    </figure>
  );
}

function OffPage({ rows, regions }: { rows: RecalcRow[]; regions: Region[] }) {
  const missing = rows.filter((row) => !regionFor(row, regions)).length;
  if (missing === 0) return null;
  return (
    <>
      {" "}
      {missing === rows.length ? "None of these cells is" : `${cellCount(missing)} of these are not`} drawn on this
      page. The table lists every cell.
    </>
  );
}

/** Above this many cracked cells, a cell's values show on hover or focus
 * only, so the callouts do not cover the page. */
const DENSE = 12;

function SheetImage({ image, rows, alt }: { image: Extract<StageImage, { phase: "ready" }>; rows: RecalcRow[]; alt: string }) {
  const placed = rows.flatMap((row) => {
    const region = regionFor(row, image.regions);
    return region ? [{ row, box: region.bbox_pt }] : [];
  });
  return (
    <div class={placed.length > DENSE ? "recalc-paper recalc-paper--dense" : "recalc-paper"}>
      <img src={image.url} alt={alt} />
      {placed.map(({ row, box }) => {
        const [x, y, w, h] = box;
        const side = x + w / 2 > image.widthPt / 2 ? "left" : "right";
        return (
          <div
            key={row.key}
            class={`recalc-crack recalc-crack--${side}`}
            style={{
              left: `${(x / image.widthPt) * 100}%`,
              top: `${(y / image.heightPt) * 100}%`,
              width: `${(w / image.widthPt) * 100}%`,
              height: `${(h / image.heightPt) * 100}%`,
            }}
            tabIndex={0}
            aria-label={`${row.label}: stored value ${row.cached.text}, Wolf's computed value ${row.computed.text}`}
          >
            <span class="recalc-shard recalc-shard--top" aria-hidden="true" />
            <span class="recalc-shard recalc-shard--bottom" aria-hidden="true" />
            <span class="recalc-callout" aria-hidden="true">
              <span class="recalc-callout-row">
                <span class="recalc-callout-label">Stored value</span>
                <span class="recalc-value">{row.cached.text}</span>
              </span>
              <span class="recalc-callout-row recalc-callout-row--computed">
                <span class="recalc-callout-label">Wolf's computed value</span>
                <span class="recalc-value">{row.computed.text}</span>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

export type RailViewProps = {
  access: RecalcAccess;
  run: RecalcRun;
  sort: SortOrder;
  onSort: (sort: SortOrder) => void;
};

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "cell", label: "Cell" },
  { key: "cached", label: "Stored value" },
  { key: "computed", label: "Wolf's computed value" },
  { key: "absolute", label: "Difference" },
  { key: "relative", label: "Relative difference" },
];

export function RecalcRailView(props: RailViewProps) {
  return (
    <section class="recalc-rail" aria-labelledby="recalc-rail-title">
      <h2 id="recalc-rail-title">Cells that differ</h2>
      <RailBody {...props} />
      <ReportFacts run={props.run} />
    </section>
  );
}

function RailBody({ access, run, sort, onSort }: RailViewProps) {
  if (access.kind === "not-a-workbook") return <p>Nothing to list for this file.</p>;
  switch (run.phase) {
    case "idle":
      return <p>Press Recalculate on the page to list each cell whose stored value differs from Wolf's computed value.</p>;
    case "running":
      return <p>Recalculating.</p>;
    case "error":
      return <p>Recalculation did not finish. The message is shown on the page.</p>;
    case "unavailable":
      return <p>Nothing to list: Wolf did not check this workbook.</p>;
    case "done":
      break;
  }
  const rows = recalcRows(run.report);
  if (rows.length === 0) {
    return <p class="recalc-result--clean">No cell differs. Every stored value matches Wolf's computed value.</p>;
  }
  return (
    <>
      <p class="recalc-method">
        Each row compares the value stored in the file with the value Wolf wrote for that cell after recalculating
        the workbook.
      </p>
      <RecalcTable rows={sortRows(rows, sort)} sort={sort} onSort={onSort} />
    </>
  );
}

function RecalcTable({ rows, sort, onSort }: { rows: RecalcRow[]; sort: SortOrder; onSort: (sort: SortOrder) => void }) {
  return (
    <div class="recalc-table-wrap">
      <table class="recalc-table">
        <caption class="recalc-sr">
          {cellCount(rows.length)} whose stored value differs from Wolf's computed value. Select a column heading to
          sort.
        </caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button type="button" onClick={() => onSort(nextSort(sort, column.key))}>
                    {column.label}
                    <span class="recalc-sort" aria-hidden="true">
                      {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid={TID.recalcRow(row.sheet, row.a1)}>
              <th scope="row">
                {row.label}
                {row.formula && <code class="recalc-formula">{row.formula}</code>}
              </th>
              <td>
                <Value value={row.cached} />
              </td>
              <td>
                <Value value={row.computed} />
              </td>
              <td class={row.diff.kind === "numeric" ? "recalc-num" : "recalc-na"}>{formatAbsolute(row.diff)}</td>
              <td class={row.diff.kind === "numeric" && row.diff.relative !== null ? "recalc-num" : "recalc-na"}>
                {formatRelative(row.diff)}
                {row.diff.kind === "not-numeric" && <span class="recalc-kind">{row.diff.reason}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Value({ value }: { value: ShownValue }) {
  return (
    <>
      <span class={`recalc-value recalc-value--${value.kind}`}>{value.text}</span>
      {value.kind !== "number" && value.kind !== "blank" && <span class="recalc-kind">{KIND_LABEL[value.kind]}</span>}
    </>
  );
}

/** What the engine said about its own run: how many formula cells it compared,
 * when the report says, and how long the call took in this tab. */
function ReportFacts({ run }: { run: RecalcRun }) {
  if (run.phase !== "done") return null;
  const { formulas, ms } = run.report;
  return (
    <dl class="recalc-claims">
      {formulas !== null && (
        <div class="recalc-claim">
          <dt>Formula cells compared</dt>
          <dd>{formulas}</dd>
        </div>
      )}
      <div class="recalc-claim">
        <dt>Time in this tab</dt>
        <dd>{ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}</dd>
      </div>
    </dl>
  );
}
