/**
 * Presentational X-ray components. They take plain props, hold no engine
 * state, and import no CSS, so tests can render them to a string.
 */
import { TID } from "../../lab/index.ts";
import type { DocFormat, Finding, KernelError } from "../../lab/index.ts";
import type { JSX } from "preact";
import {
  KIND_LABEL,
  KIND_TAG,
  bboxOffPage,
  clampPct,
  groupFindings,
  isLocated,
  type LocatedFinding,
  type ParserSegment,
  type ParserText,
} from "./model.ts";
import type { Loaded, LoupePoint } from "./store.ts";

const FORMAT_NAME: Record<DocFormat, string> = { docx: "DOCX", xlsx: "XLSX", pptx: "PPTX" };

/** What an enclosing node is called in "this ... contains hidden text". */
function containerNoun(address: string): string {
  return address.startsWith("para:") || address.includes("/para:") ? "paragraph" : "block";
}

function domId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function ErrorPanel({ error, lead }: { error: KernelError; lead: string }) {
  return (
    <div class="xray-error" role="alert" data-testid={TID.errorPanel} data-code={error.code}>
      <p>
        {lead} <code>{error.code}</code>
      </p>
      <p>{error.message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

export type RailViewProps = {
  format: DocFormat;
  loaded: Loaded<Finding[]>;
  selectedId: string | null;
  onSelect: (finding: Finding) => void;
};

export function RailView({ format, loaded, selectedId, onSelect }: RailViewProps) {
  const findings = loaded.status === "ready" ? loaded.value : [];
  const groups = groupFindings(findings);
  return (
    <div class="xray-rail">
      <header class="xray-rail__head">
        <h2>Findings</h2>
        {loaded.status === "ready" && (
          <p>
            <span data-testid={TID.xrayCount}>{findings.length}</span> {findings.length === 1 ? "finding" : "findings"}{" "}
            from the engine
          </p>
        )}
      </header>

      {loaded.status === "loading" && <p role="status">Asking the engine for findings.</p>}
      {loaded.status === "error" && <ErrorPanel error={loaded.error} lead="The engine could not list findings:" />}

      {loaded.status === "ready" && findings.length === 0 && (
        <div class="xray-empty" role="status">
          <p>
            The engine labelled nothing hidden in this {FORMAT_NAME[format]} file. Content the engine does not label
            is not listed here.
          </p>
        </div>
      )}

      {groups.map((group) => {
        const headingId = domId("xray-group", group.key);
        return (
          <section class="xray-group" key={group.key} aria-labelledby={headingId}>
            <h3 id={headingId} class="xray-group__head">
              <span>{KIND_LABEL[group.kind]}</span> <code>{group.reason}</code>{" "}
              <span class="xray-group__count">
                {group.findings.length} {group.findings.length === 1 ? "item" : "items"}
              </span>
            </h3>
            <ul class="xray-group__list">
              {group.findings.map((finding) => (
                <FindingItem
                  key={finding.id}
                  finding={finding}
                  selected={finding.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function FindingItem({
  finding,
  selected,
  onSelect,
}: {
  finding: Finding;
  selected: boolean;
  onSelect: (finding: Finding) => void;
}) {
  const detailId = domId("xray-detail", finding.id);
  const located = isLocated(finding);
  const container = finding.granularity === "container";
  return (
    <li class={selected ? "xray-item is-selected" : "xray-item"}>
      <button
        type="button"
        class="xray-item__button"
        data-testid={TID.xrayFinding(finding.id)}
        data-located={located ? "true" : "false"}
        aria-expanded={selected}
        aria-controls={detailId}
        onFocus={() => onSelect(finding)}
        onClick={() => onSelect(finding)}
      >
        <span class="xray-item__address">{finding.address}</span>
        <span class="xray-item__meta">
          {finding.chars !== undefined ? `${finding.chars} characters` : "Length not reported"}
          {" · "}
          {located ? `page ${finding.page}` : "no page position"}
          {container && ` · contains hidden text`}
        </span>
        <span class="xray-item__text">{finding.text ?? "No text reported"}</span>
      </button>
      <div id={detailId} class="xray-item__detail" hidden={!selected}>
        {container && (
          <p>
            This {containerNoun(finding.address)} contains hidden text. The text above is the whole{" "}
            {containerNoun(finding.address)}, including parts the reader sees on the page.
          </p>
        )}
        {located ? (
          <p>The loupe is on it, on page {finding.page}.</p>
        ) : (
          <p>This finding has no position on the page, so the loupe cannot show it. Its text is above.</p>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// What a text parser hands your model
// ---------------------------------------------------------------------------

export type CopyState = "idle" | "copied" | "failed";

export type ParserPaneViewProps = {
  parser: ParserText | null;
  nodesAvailable: boolean;
  selectedId: string | null;
  copy: CopyState;
  onCopy: () => void;
};

function segmentTag(segment: ParserSegment): { hidden: boolean; label: string } | null {
  if (segment.findings.length === 0) return null;
  const exact = segment.findings.filter((f) => f.granularity !== "container");
  if (exact.length > 0) {
    return { hidden: true, label: exact.map((f) => `${KIND_TAG[f.kind]}: ${f.reason}`).join(", ") };
  }
  const reasons = segment.findings.map((f) => f.reason).join(", ");
  return { hidden: false, label: `${containerNoun(segment.address)} contains hidden text: ${reasons}` };
}

function Segment({ segment, selectedId }: { segment: ParserSegment; selectedId: string | null }) {
  const tag = segmentTag(segment);
  if (!tag) return <span class="xray-seg">{segment.text}</span>;
  const selected = selectedId !== null && segment.findings.some((f) => f.id === selectedId);
  const cls = `xray-seg ${tag.hidden ? "xray-seg--hidden" : "xray-seg--contains"}${selected ? " is-selected" : ""}`;
  const body = (
    <>
      <span class="xray-seg__tag">[{tag.label}]</span> {segment.text}
    </>
  );
  return tag.hidden ? (
    <mark class={cls} data-address={segment.address}>
      {body}
    </mark>
  ) : (
    <span class={cls} data-address={segment.address}>
      {body}
    </span>
  );
}

export function ParserPaneView({ parser, nodesAvailable, selectedId, copy, onCopy }: ParserPaneViewProps) {
  const placed = parser?.segments.filter((s) => s.placed) ?? [];
  const unplaced = parser?.segments.filter((s) => !s.placed) ?? [];
  return (
    <section class="xray-parser" data-testid={TID.xrayParserPane} aria-labelledby="xray-parser-title">
      <header class="xray-parser__head">
        <div>
          <h2 id="xray-parser-title">What a text parser hands your model</h2>
          <p>The engine's observe output, in reading order. Hidden spans are marked.</p>
        </div>
        <div class="xray-parser__actions">
          <button type="button" onClick={onCopy} disabled={!parser || parser.plain.length === 0}>
            Copy text
          </button>
          <span role="status" aria-live="polite">
            {copy === "copied" ? "Copied." : copy === "failed" ? "Copy failed. Select the text and copy it." : ""}
          </span>
        </div>
      </header>
      {!parser && <p role="status">Waiting for the engine's findings.</p>}
      {parser && !nodesAvailable && (
        <p class="xray-note">
          This recording does not include the observe text, so only the hidden spans the engine reported are listed.
        </p>
      )}
      {parser && placed.length > 0 && (
        <div class="xray-parser__text" tabIndex={0} role="region" aria-label="Parser text in reading order">
          {placed.map((segment, index) => (
            <Segment key={`${segment.address}:${index}`} segment={segment} selectedId={selectedId} />
          ))}
        </div>
      )}
      {unplaced.length > 0 && (
        <>
          <h3>Reported by the engine without a place in the reading order</h3>
          <div class="xray-parser__text" tabIndex={0} role="region" aria-label="Hidden text without a reading position">
            {unplaced.map((segment, index) => (
              <Segment key={`${segment.address}:${index}`} segment={segment} selectedId={selectedId} />
            ))}
          </div>
        </>
      )}
      {parser && parser.segments.length === 0 && <p>The engine reported no text for this file.</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page and loupe
// ---------------------------------------------------------------------------

export type PageViewProps = {
  page: number;
  pageCount: number;
  /** Page size in points, for placing boxes. */
  widthPt: number;
  heightPt: number;
  image: Loaded<string>;
  located: LocatedFinding[];
  selected: Finding | null;
  loupe: LoupePoint;
  glide: boolean;
  onLoupe: (point: LoupePoint, via: "pointer" | "key") => void;
  onPage: (page: number) => void;
};

const KEY_STEP: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function loupeStatus(props: PageViewProps): string {
  const { selected, located, page, widthPt, heightPt } = props;
  if (selected && isLocated(selected) && selected.page === page) {
    const edge = bboxOffPage(selected.bboxPt, widthPt, heightPt) ? " Its position is outside the page edge." : "";
    return `Loupe on page ${page}: ${selected.reason} at ${selected.address}.${edge}`;
  }
  if (selected && !isLocated(selected)) {
    return `${selected.address} has no position on the page. Read it in the findings list.`;
  }
  if (located.length === 0) return "No finding on this page has a position, so the loupe shows the page only.";
  return "Move the pointer over the page, or tab through the findings, to move the loupe.";
}

export function PageView(props: PageViewProps) {
  const { page, pageCount, widthPt, heightPt, image, located, selected, loupe, glide, onLoupe, onPage } = props;
  const pct = (value: number, of: number) => `${(value / of) * 100}%`;

  const onPointerMove = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    onLoupe(
      {
        x: clampPct(((event.clientX - rect.left) / rect.width) * 100),
        y: clampPct(((event.clientY - rect.top) / rect.height) * 100),
      },
      "pointer",
    );
  };
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const size = event.shiftKey ? 1 : 5;
    onLoupe({ x: clampPct(loupe.x + step[0] * size), y: clampPct(loupe.y + step[1] * size) }, "key");
  };

  const loupeStyle = { "--loupe-x": `${loupe.x}%`, "--loupe-y": `${loupe.y}%` };

  return (
    <div class="xray-stage">
      {pageCount > 1 && (
        <nav class="xray-pagebar" aria-label="Pages">
          <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
            Previous page
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
            Next page
          </button>
        </nav>
      )}
      <div
        class={glide ? "xray-page is-gliding" : "xray-page"}
        style={{ aspectRatio: `${widthPt} / ${heightPt}`, ...loupeStyle }}
        tabIndex={0}
        role="group"
        aria-label={`Page ${page} as the reader sees it. Arrow keys move the loupe.`}
        aria-describedby="xray-loupe-status"
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      >
        {image.status === "ready" && <img class="xray-page__image" src={image.value} alt={`Page ${page}`} />}
        {image.status === "loading" && <p class="xray-page__state">Drawing the page.</p>}
        {image.status === "error" && <ErrorPanel error={image.error} lead="The engine could not draw this page:" />}
        <div class="xray-loupe-layer" aria-hidden="true">
          {located.map((finding) => {
            const [x, y, w, h] = finding.bboxPt;
            const cls = `xray-mark${finding.id === selected?.id ? " is-selected" : ""}`;
            const label =
              finding.granularity === "container"
                ? `${containerNoun(finding.address)} contains hidden text: ${finding.reason}`
                : finding.reason;
            return (
              <div
                key={finding.id}
                class={cls}
                style={{ left: pct(x, widthPt), top: pct(y, heightPt), width: pct(w, widthPt), height: pct(h, heightPt) }}
              >
                <span class="xray-mark__label">{label}</span>
                {finding.text && <span class="xray-mark__text">{finding.text}</span>}
              </div>
            );
          })}
        </div>
        <div class="xray-loupe-ring" aria-hidden="true" />
      </div>
      <p id="xray-loupe-status" class="xray-loupe-status" role="status">
        {loupeStatus(props)}
      </p>
    </div>
  );
}
