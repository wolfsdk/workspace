import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  addressOnSide,
  changesOf,
  countsText,
  describeEntry,
  describeFindingParts,
  formatTime,
  formatTyped,
  sideShown,
  tableCellRegions,
  type Change,
  type DocFormat,
  type Hunk,
  type Item,
  type PartFinding,
  type Rel,
  type SessionExport,
} from "@wolfsdk/protocol";
import { useEditor, type EditorHost, type HistoryEntry, type PluginProps } from "../host/index.ts";
import { CompareToggle } from "./compareView.tsx";
import { useReview } from "./hooks.ts";
import {
  afterRender,
  focusAfterReject,
  focusEntry,
  handleListKey,
  registerPanel,
  rejectHunk,
  toggleHunk,
} from "./keys.ts";
import type { ReviewStore } from "./store.ts";

/** Long text values are cut for the row; the full value is in the row's title. */
function clip(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/** The hunk of changes whose `cause` names no op. A workbook's are recalculated and derived values; in a document or
 * deck the engine attributes nothing to them, and its diff can report changes no op made, so the panel does not call
 * them derived there. */
function uncausedName(format: DocFormat | undefined): { title: string; noun: string } {
  return format === "xlsx"
    ? { title: "Recalculated and derived", noun: "recalculated and derived values" }
    : { title: "Not traced to an operation", noun: "changes not traced to an operation" };
}

function expanded0(store: ReviewStore, entry: HistoryEntry): Item[] {
  return describeEntry(entry, {
    nameOf: (a) => store.host.node(a)?.label,
    nodeOf: (a) => {
      const n = store.host.node(a);
      if (!n) return undefined;
      return {
        label: n.label,
        text: n.text,
        revision_kind: typeof n.revision_kind === "string" ? n.revision_kind : undefined,
      };
    },
  });
}

function ChangeRow(props: {
  store: ReviewStore;
  entry: HistoryEntry;
  item: Item;
  change: Change;
  regionIds: Set<string>;
  side: "before" | "after" | null;
}) {
  const { store, entry, item, change, regionIds, side } = props;
  const index = item.primary;
  // On page while a region carries the address of the row or of a record folded into it: a deck table
  // cell edit folds the cell, its paragraph and its run under the paragraph, and only the cell is drawn.
  const drawn = (c: Change | undefined): boolean => {
    const addr = side && c ? addressOnSide(entry, c, side) : null;
    return addr !== null && regionIds.has(addr);
  };
  const changes = changesOf(entry);
  const notOnPage = side !== null && !drawn(change) && !item.indices.some((i) => drawn(changes[i]));
  const sel = store.ui.selectedChange;
  const selected = sel?.revision === entry.revision && item.indices.includes(sel.index);
  const [open, setOpen] = useState(false);
  const folded = item.indices.length > 1;
  // A record folded into this row is selected (Alt+ArrowDown, or its outline on the page): show the
  // row's records so the selected one can be seen.
  const inner = selected && sel!.index !== index ? sel!.index : -1;
  useEffect(() => {
    if (inner >= 0) setOpen(true);
  }, [inner]);
  return (
    <li
      class={`we-review-change we-review-${item.kind}${selected ? " we-review-selected" : ""}`}
      data-testid={`review-change-${entry.revision}-${index}`}
      data-review-revision={entry.revision}
      data-review-primary={index}
    >
      <button
        type="button"
        class="we-review-change-btn"
        title={`${item.label}\n${item.address}${item.values ? `\n${item.values.property ? `${item.values.property}: ` : ""}${item.values.before} -> ${item.values.after}` : ""}`}
        aria-label={`Select ${item.label}`}
        data-testid={`review-change-${entry.revision}-${index}-select`}
        onClick={() => void store.selectChange(entry, index)}
      >
        <span class="we-review-kind" title={item.label}>
          {item.label}
        </span>
        <span class="we-review-address" title={item.address}>
          {item.address}
        </span>
        {item.values ? (
          <span
            class="we-review-values"
            title={`${item.values.property ? `${item.values.property}: ` : ""}${item.values.before} -> ${item.values.after}`}
          >
            {item.values.property ? `${item.values.property}: ` : ""}
            <del>{clip(item.values.before)}</del> <span class="we-review-arrow">-&gt;</span>{" "}
            <ins>{clip(item.values.after)}</ins>
          </span>
        ) : null}
        {item.notes.map((note) => (
          <span key={note} class="we-review-values" title={note}>
            {clip(note, 120)}
          </span>
        ))}
        {notOnPage ? (
          <span class="we-chip we-review-offpage" data-testid={`review-offpage-${entry.revision}-${index}`}>
            not on page
          </span>
        ) : null}
      </button>
      {folded ? (
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title={open ? "Hide the individual records" : "Show the individual records"}
          aria-label={open ? `Hide records of ${item.label}` : `Show records of ${item.label}`}
          aria-expanded={open}
          data-testid={`review-change-${entry.revision}-${index}-detail`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide records" : `${item.indices.length} records`}
        </button>
      ) : null}
      {folded && open ? (
        <ul class="we-review-detail" data-testid={`review-change-${entry.revision}-${index}-records`}>
          {item.indices.map((i) => {
            const c = changesOf(entry)[i]!;
            const current = selected && sel!.index === i;
            return (
              <li
                key={i}
                class={`we-review-values${current ? " we-review-record-selected" : ""}`}
                aria-current={current ? "true" : undefined}
                data-testid={`review-change-${entry.revision}-${index}-record-${i}`}
              >
                {`${c.change} ${c.kind} ${c.address}${c.property ? ` ${c.property}` : ""}${c.change === "modified" ? `: ${formatTyped(c.before)} -> ${formatTyped(c.after)}` : ""}`}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** Change rows with a group heading wherever the group changes (when there is more than one).
 * `groupIds` given: only the first heading of a group in the entry carries the test id. */
function ChangeRows(props: {
  store: ReviewStore;
  entry: HistoryEntry;
  items: Item[];
  regionIds: Set<string>;
  side: "before" | "after" | null;
  groupIds: Set<string> | null;
}) {
  const { store, entry, items, regionIds, side, groupIds } = props;
  const changes = changesOf(entry);
  const several = new Set(items.map((i) => i.group)).size > 1;
  return (
    <Fragment>
      {items.map((item, n) => {
        const heading = several && (n === 0 || items[n - 1]!.group !== item.group);
        const slug = item.group.toLowerCase().replace(/[^a-z]+/g, "-");
        const withId = heading && (groupIds === null || !groupIds.has(slug));
        if (withId) groupIds?.add(slug);
        return (
          <Fragment key={item.primary}>
            {heading ? (
              <li
                key={`g-${item.group}`}
                class="we-review-group"
                data-testid={withId ? `review-entry-${entry.revision}-group-${slug}` : undefined}
              >
                {item.group}
              </li>
            ) : null}
            <ChangeRow
              key={item.primary}
              store={store}
              entry={entry}
              item={item}
              change={changes[item.primary]!}
              regionIds={regionIds}
              side={side}
            />
          </Fragment>
        );
      })}
    </Fragment>
  );
}

/** One hunk of a multi-op entry: what one op changed, with its own decision. */
function HunkBlock(props: {
  store: ReviewStore;
  entry: HistoryEntry;
  hunk: Hunk | null;
  children: ComponentChildren;
  empty: boolean;
}) {
  const { store, entry, hunk, children, empty } = props;
  const rev = entry.revision;
  if (hunk === null) {
    // Changes whose cause names no op of the entry; shown so nothing is hidden.
    return (
      <li class="we-review-hunk">
        <div class="we-review-hunk-head">
          <span class="we-review-hunk-title">Other changes</span>
        </div>
        <ul class="we-review-changes we-review-hunk-changes">{children}</ul>
      </li>
    );
  }
  const op = hunk.op;
  const id = `review-hunk-${rev}-${op === null ? "none" : op}`;
  const decision = store.hunkDecisionOf(entry, op);
  const working = store.ui.working !== null;
  const o = op === null ? undefined : entry.ops[op];
  const where = typeof o?.target === "string" ? o.target : typeof o?.anchor === "string" ? o.anchor : "";
  const summary = o ? `${o.op}${where ? ` ${where}` : ""}` : "";
  const uncaused = uncausedName(store.host.getSnapshot().state?.format);
  const name = op === null ? `${uncaused.noun} of revision ${rev}` : `change ${op + 1} of revision ${rev}`;
  return (
    <li class={`we-review-hunk we-review-d-${decision}`} data-testid={id} data-decision={decision}>
      <div class="we-review-hunk-head">
        <span class="we-review-hunk-title">
          {op === null ? uncaused.title : `Change ${op + 1} of ${entry.ops.length}`}
          {decision !== "pending" ? (
            <span class={`we-chip we-chip--${decision === "approve" ? "success" : "danger"}`}>
              {decision === "approve" ? "approved" : "rejected"}
            </span>
          ) : null}
        </span>
        {summary ? (
          <span class="we-review-address" title={summary}>
            {summary}
          </span>
        ) : null}
      </div>
      <div class="we-review-decide">
        <button
          type="button"
          class={`we-btn we-btn--small${decision === "approve" ? " we-btn--success" : " we-btn--outline"}`}
          title={op === null ? `Approve the ${uncaused.noun}` : "Approve this change"}
          aria-label={`Approve ${name}`}
          aria-pressed={decision === "approve"}
          data-testid={`${id}-approve`}
          disabled={working}
          onClick={() => toggleHunk(store, entry, op)}
        >
          Approve
        </button>
        {op !== null ? (
          <button
            type="button"
            class={`we-btn we-btn--small${decision === "reject" ? " we-btn--danger" : " we-btn--outline"}`}
            title="Remove only this change and keep the rest of the change set"
            aria-label={`Reject ${name}`}
            aria-pressed={decision === "reject"}
            data-testid={`${id}-reject`}
            disabled={working}
            onClick={() => void rejectHunk(store, entry, [op])}
          >
            Reject
          </button>
        ) : null}
      </div>
      {empty ? (
        <div class="we-notice we-notice--warning we-review-hunk-empty">No visible change reported</div>
      ) : (
        <ul class="we-review-changes we-review-hunk-changes">{children}</ul>
      )}
    </li>
  );
}

function Entry(props: { store: ReviewStore; entry: HistoryEntry; current: number }) {
  const { store, entry, current } = props;
  const snap = store.host.getSnapshot();
  const decision = store.decisionOf(entry);
  const changes = changesOf(entry);
  const items = expanded0(store, entry);
  const expanded = store.ui.expanded.has(entry.revision);
  const inspected = store.inspectedEntry()?.revision === entry.revision;
  const side = sideShown(entry, snap.state);
  const regionIds = new Set(
    snap.state ? [...snap.state.regions, ...tableCellRegions(snap.state)].map((r) => r.object_id) : [],
  );
  const rev = entry.revision;
  // One op keeps the flat list; several ops group the rows under one block per hunk.
  const hunks = entry.ops.length > 1 ? store.hunks(entry) : null;
  const anyHunkDecided = hunks?.some((h) => store.hunkDecisionOf(entry, h.op) !== "pending") ?? false;
  return (
    <li
      class={`we-review-entry${rev === current ? " we-review-current" : ""}${rev > current ? " we-review-tail" : ""}${inspected ? " we-review-inspected" : ""} we-review-d-${decision}`}
      data-testid={`review-entry-${rev}`}
      data-current={rev === current ? "true" : "false"}
      data-tail={rev > current ? "true" : "false"}
      data-decision={decision}
    >
      <div class="we-review-entry-head">
        <button
          type="button"
          class="we-btn we-btn--small we-btn--icon"
          title={expanded ? "Hide changes" : "Show changes"}
          aria-label={expanded ? `Hide changes of revision ${rev}` : `Show changes of revision ${rev}`}
          aria-expanded={expanded}
          data-testid={`review-entry-${rev}-toggle`}
          onClick={() => store.toggleExpanded(rev)}
        >
          {expanded ? "v" : ">"}
        </button>
        <button
          type="button"
          class="we-review-entry-main"
          title={`Go to revision ${rev}`}
          aria-label={`Go to revision ${rev}: ${entry.label}`}
          data-testid={`review-entry-${rev}-go`}
          onClick={() => void store.inspect(entry)}
        >
          <span class="we-review-entry-title">
            {`#${rev} ${entry.label}`}
            {rev === current ? (
              <span class="we-chip we-chip--info" data-testid={`review-entry-${rev}-current`}>
                current
              </span>
            ) : null}
            {decision !== "pending" ? (
              <span class={`we-chip we-chip--${decision === "approve" ? "success" : "danger"}`}>
                {decision === "approve" ? "approved" : "rejected"}
              </span>
            ) : null}
          </span>
          <span class="we-review-entry-meta">{`${entry.source} - ${formatTime(entry.appliedAt)} - ${countsText(changes)}`}</span>
        </button>
      </div>
      <div class="we-review-decide">
        <button
          type="button"
          class={`we-btn we-btn--small${decision === "approve" ? " we-btn--success" : " we-btn--outline"}`}
          title="Approve this change set"
          aria-label={`Approve revision ${rev}`}
          aria-pressed={decision === "approve"}
          data-testid={`review-entry-${rev}-approve`}
          onClick={() => store.approve(entry)}
        >
          Approve
        </button>
        <button
          type="button"
          class={`we-btn we-btn--small${decision === "reject" ? " we-btn--danger" : " we-btn--outline"}`}
          title="Reject this change set"
          aria-label={`Reject revision ${rev}`}
          aria-pressed={decision === "reject"}
          data-testid={`review-entry-${rev}-reject`}
          disabled={store.ui.working !== null}
          onClick={() => void store.reject(entry)}
        >
          Reject
        </button>
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Clear the decision"
          aria-label={`Clear decision for revision ${rev}`}
          data-testid={`review-entry-${rev}-clear`}
          disabled={decision === "pending" && !anyHunkDecided}
          onClick={() => store.setDecision(entry, "pending")}
        >
          Clear
        </button>
      </div>
      {store.ui.choosing === rev ? (
        <div
          class="we-review-choice"
          role="group"
          aria-label="Reject options"
          data-testid={`review-entry-${rev}-choice`}
        >
          <p class="we-review-choice-prompt">{`Later change sets were made on top of #${rev}. Reject which?`}</p>
          <button
            type="button"
            class="we-btn we-btn--small we-btn--outline we-btn--danger-quiet"
            title="Go back to before this change set; later change sets stay in the redo tail"
            aria-label={`Reject revision ${rev} and everything after it`}
            data-testid={`review-entry-${rev}-reject-after`}
            onClick={() => void store.rejectWithAfter(entry).then(() => focusAfterReject(store, rev))}
          >
            Reject this and everything after it
          </button>
          <button
            type="button"
            class="we-btn we-btn--small we-btn--outline we-btn--danger-quiet"
            title="Remove only this change set and re-apply the later ones"
            aria-label={`Reject only revision ${rev}`}
            data-testid={`review-entry-${rev}-reject-only`}
            onClick={() => void store.rejectOnly(entry).then(() => focusAfterReject(store, rev))}
          >
            Reject only this
          </button>
          <button
            type="button"
            class="we-btn we-btn--small we-btn--outline"
            title="Cancel"
            aria-label="Cancel reject"
            data-testid={`review-entry-${rev}-reject-cancel`}
            onClick={() => {
              store.patch({ choosing: null });
              afterRender(() => focusEntry(rev));
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {expanded ? (
        <ul class="we-review-changes" data-testid={`review-entry-${rev}-changes`}>
          {hunks ? (
            <HunkList store={store} entry={entry} hunks={hunks} items={items} regionIds={regionIds} side={side} />
          ) : (
            <Fragment>
              <ChangeRows store={store} entry={entry} items={items} regionIds={regionIds} side={side} groupIds={null} />
              {items.length === 0 ? <li class="we-review-muted">No semantic changes.</li> : null}
            </Fragment>
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** The hunk blocks of a multi-op entry. An item belongs to the hunk holding its primary change. */
function HunkList(props: {
  store: ReviewStore;
  entry: HistoryEntry;
  hunks: Hunk[];
  items: Item[];
  regionIds: Set<string>;
  side: "before" | "after" | null;
}) {
  const { store, entry, hunks, items, regionIds, side } = props;
  const groupIds = new Set<string>();
  const rows = (own: Item[]) => (
    <ChangeRows store={store} entry={entry} items={own} regionIds={regionIds} side={side} groupIds={groupIds} />
  );
  const rest = items.filter((item) => !hunks.some((h) => h.changeIndices.includes(item.primary)));
  return (
    <Fragment>
      {hunks.map((hunk) => {
        const own = items.filter((item) => hunk.changeIndices.includes(item.primary));
        return (
          <HunkBlock key={String(hunk.op)} store={store} entry={entry} hunk={hunk} empty={own.length === 0}>
            {rows(own)}
          </HunkBlock>
        );
      })}
      {rest.length ? (
        <HunkBlock key="other" store={store} entry={entry} hunk={null} empty={false}>
          {rows(rest)}
        </HunkBlock>
      ) : null}
    </Fragment>
  );
}

/** "change 2", "changes 2 and 3", "changes 1, 2 and 4" for zero-based op indices. */
function changeNames(ops: number[]): string {
  const n = ops.map((o) => String(o + 1));
  return n.length === 1 ? `change ${n[0]}` : `changes ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}

/** The last refused reject: which kept changes depend on the rejected ones. Nothing was applied. */
function CoupledNotice({ store }: { store: ReviewStore }) {
  const c = store.ui.coupled;
  if (!c) return null;
  const hist = store.history();
  const entry = hist.find((e) => e.revision === c.revision);
  const nameOf = (revision: number): string => {
    const e = hist.find((h) => h.revision === revision);
    return e ? `#${revision} ${e.label}` : `revision ${revision}`;
  };
  const rejected = c.ops.length > 1 ? "the rejected changes" : "the rejected change";
  const later = c.coupled.some((k) => k.revision > c.revision);
  // "Reject together" only when every dependent is a numbered op of the same entry.
  const deps = c.coupled.flatMap((k) => (k.revision === c.revision && typeof k.op === "number" ? [k.op] : []));
  const together =
    entry && deps.length === c.coupled.length ? [...new Set([...c.ops, ...deps])].sort((a, b) => a - b) : null;
  const uncaused = uncausedName(store.host.getSnapshot().state?.format);
  return (
    <div class="we-notice we-notice--warning we-review-coupled" role="alert" data-testid="review-coupled">
      <p class="we-review-coupled-title">
        {`Rejecting ${changeNames(c.ops)} of ${nameOf(c.revision)} was stopped. ${
          c.restored
            ? "Nothing was changed."
            : "The earlier state could not be fully restored: check the history before deciding anything else."
        }`}
      </p>
      <ul class="we-review-coupled-list">
        {c.coupled.map((k, i) => {
          const who = k.op === null ? uncaused.noun.replace(/^./, (c) => c.toUpperCase()) : `Change ${k.op + 1}`;
          const where = k.revision !== c.revision ? ` of ${nameOf(k.revision)}` : "";
          const how = k.kind === "unverifiable" ? `could not be checked without ${rejected}` : `depends on ${rejected}`;
          return <li key={i}>{`${who}${where} ${how}: ${k.detail}`}</li>;
        })}
      </ul>
      {later ? <p>Reject that later change first, or use Reject this and everything after it.</p> : null}
      <div class="we-review-decide">
        {entry && together ? (
          <button
            type="button"
            class="we-btn we-btn--small we-btn--danger"
            title="Reject the rejected change and every change that depends on it"
            aria-label={`Reject ${changeNames(together)} of revision ${c.revision} together`}
            data-testid="review-coupled-reject-together"
            disabled={store.ui.working !== null}
            onClick={() => void rejectHunk(store, entry, together)}
          >
            Reject together
          </button>
        ) : null}
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Keep every change and close this notice"
          aria-label="Keep the changes"
          data-testid="review-coupled-dismiss"
          onClick={() => {
            // The coupled notice says why; the status line would only repeat it.
            store.patch({ coupled: null, notice: null, failure: null });
            afterRender(() => focusEntry(c.revision));
          }}
        >
          Keep
        </button>
      </div>
    </div>
  );
}

/** Quiet time after the last revision change before the parts check runs (stepping through history). */
const PARTS_DEBOUNCE_MS = 500;

const bytes = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "byte" : "bytes"}`;
const linkEnd = (r: Rel, max: number): string => `${clip(r.target, max)}${r.external ? " (outside the file)" : ""}`;

/** The finding's detail as short lines (full targets in `title`): one per added, removed or changed
 * link of a relationship part, else the size change. */
function detailLines(f: PartFinding): { text: string; title?: string }[] {
  const d = f.detail;
  if (!d) return [];
  const rels = d.relationships;
  const out: { text: string; title?: string }[] = [];
  if (rels) {
    for (const r of rels.added) out.push({ text: `Added ${r.type} link to ${linkEnd(r, 60)}`, title: r.target });
    for (const r of rels.removed) out.push({ text: `Removed ${r.type} link to ${linkEnd(r, 60)}`, title: r.target });
    for (const { before: b, after: a } of rels.changed)
      out.push({
        text: `Changed link ${a.id}: ${b.type} to ${linkEnd(b, 36)}, now ${a.type} to ${linkEnd(a, 36)}`,
        title: `${b.target} -> ${a.target}`,
      });
    if (out.length) return out;
  }
  if (d.sizeBefore === null && d.sizeAfter !== null) out.push({ text: `New part, ${bytes(d.sizeAfter)}` });
  else if (d.sizeAfter === null && d.sizeBefore !== null) out.push({ text: `Removed, was ${bytes(d.sizeBefore)}` });
  else if (d.sizeBefore !== null && d.sizeAfter !== null)
    out.push({
      text:
        d.sizeBefore === d.sizeAfter
          ? `Same size (${bytes(d.sizeAfter)}), different content`
          : `${bytes(d.sizeAfter)}, was ${bytes(d.sizeBefore)}`,
    });
  return out;
}

/** Package parts of the current revision that no reviewed change explains. */
function PartsSection({ store, busy }: { store: ReviewStore; busy: boolean }) {
  const pc = store.partsCheck;
  const sha = store.host.getSnapshot().state?.sha256 ?? null;
  useEffect(() => {
    if (pc.status !== "stale" || busy || !sha) return;
    const timer = setTimeout(() => void store.refreshParts(), PARTS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, pc.status, busy, sha]);
  const report = pc.status === "ready" ? pc.report : null;
  let body: ComponentChildren;
  if (pc.status === "failed")
    body = (
      <div class="we-notice we-notice--error we-review-parts-failed" role="alert">
        <p>{`The file could not be checked for changes that no reviewed edit explains: ${pc.error ?? "unknown error"}`}</p>
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Compare the file with the original again"
          data-testid="review-parts-retry"
          disabled={busy}
          onClick={() => void store.refreshParts()}
        >
          Check again
        </button>
      </div>
    );
  else if (!report)
    body = (
      <p class="we-review-parts-line" data-testid="review-parts-checking">
        Checking which parts of the file changed...
      </p>
    );
  else if (report.unexplained.length === 0)
    body = (
      <p class="we-review-parts-line" data-testid="review-parts-ok">
        {`Every changed part of the file is explained by a reviewed change (${report.changed} ${report.changed === 1 ? "part" : "parts"}).`}
      </p>
    );
  else {
    // Unreported first: changed with no engine receipt at all.
    const findings = [...report.unexplained].sort(
      (a, b) => Number(b.verdict === "unreported") - Number(a.verdict === "unreported"),
    );
    body = (
      <div class="we-notice we-notice--warning we-review-parts-warn">
        <p class="we-review-coupled-title">
          {`${findings.length} ${findings.length === 1 ? "part of the file changed" : "parts of the file changed"} without a reviewed change explaining ${findings.length === 1 ? "it" : "them"}.`}
        </p>
        <ul class="we-review-parts-list">
          {findings.map((f, i) => {
            // One detail line only repeats the headline; a list of several says which is which.
            const detail = detailLines(f);
            const lines = detail.length > 1 ? detail : [];
            const { headline, reason } = describeFindingParts(f);
            // The reason starts with the part name: show it once, set in code.
            const rest = reason.startsWith(f.name) ? reason.slice(f.name.length) : ` ${reason}`;
            return (
              <li
                key={f.name}
                class={`we-review-part we-review-part--${f.verdict}`}
                data-testid={`review-parts-finding-${i}`}
                data-verdict={f.verdict}
              >
                {headline ? <p class="we-review-part-headline">{headline}</p> : null}
                <p class="we-review-part-reason">
                  <code class="we-review-part-name">{f.name}</code>
                  {rest}
                </p>
                {lines.length ? (
                  <ul class="we-review-part-detail">
                    {lines.map((l, j) => (
                      <li key={j} title={l.title}>
                        {l.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <label class="we-review-part-ack">
                  <input
                    type="checkbox"
                    data-testid={`review-parts-ack-${i}`}
                    checked={store.partAcknowledged(f.name)}
                    onChange={(e) => store.acknowledgePart(f.name, e.currentTarget.checked)}
                  />
                  I have checked this
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  return (
    <section class="we-review-section we-review-parts" aria-label="Unexplained changes" data-testid="review-parts">
      <h3>Unexplained changes</h3>
      <div aria-live="polite">{body}</div>
    </section>
  );
}

/** Review mode: hand the approved file to the embedding page. */
function SubmitBox({ store }: { store: ReviewStore }) {
  const [busy, setBusy] = useState(false);
  const blockers = store.submitBlockers();
  async function run() {
    setBusy(true);
    try {
      await store.submit();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="we-review-section" aria-label="Submit review">
      <button
        type="button"
        class="we-btn we-btn--primary we-review-submit"
        title="Send the file with only the approved changes"
        aria-label="Submit review"
        data-testid="review-submit"
        disabled={busy || blockers.length > 0}
        onClick={() => void run()}
      >
        Submit review
      </button>
      {blockers.length ? (
        <ul class="we-review-blockers" data-testid="review-submit-blockers">
          {blockers.map((b) => (
            <li key={`${b.code}:${b.message}`} data-code={b.code}>
              {b.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ManualOps({ store }: { store: ReviewStore }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await store.applyManual(text);
      if (!r.ok) setError({ code: r.code, message: r.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="we-review-section" aria-label="Manual ops">
      <h3>Manual ops</h3>
      <textarea
        class="we-input we-review-manual"
        rows={5}
        spellcheck={false}
        placeholder='[{"op":"set","target":"para:~...","value":{"text":"..."}}]'
        aria-label="Operations JSON array"
        data-testid="review-manual-text"
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <button
        type="button"
        class="we-btn we-btn--small we-btn--outline"
        title="Apply these operations through the editor host"
        aria-label="Manual ops"
        data-testid="review-manual-apply"
        disabled={busy || text.trim() === ""}
        onClick={() => void run()}
      >
        Manual ops
      </button>
      {error ? (
        <div class="we-notice we-notice--error" role="alert" data-testid="review-manual-error">
          <code>{error.code}</code>: {error.message}
        </div>
      ) : null}
    </section>
  );
}

function ExportBox({ store, host }: { store: ReviewStore; host: EditorHost }) {
  const snap = useEditor(host);
  const [json, setJson] = useState("");
  const key = `${store.version}`;
  useEffect(() => {
    let live = true;
    void store.buildExport().then((doc) => {
      if (live) setJson(doc ? JSON.stringify(doc, null, 2) : "");
    });
    return () => {
      live = false;
    };
  }, [key, snap.state?.sha256]);
  function download() {
    void store.downloadExport();
  }
  return (
    <section class="we-review-section" aria-label="Decision file">
      <h3>Decision file</h3>
      <button
        type="button"
        class="we-btn we-btn--small we-btn--outline"
        title="Download the review decision file"
        aria-label="Download decision file"
        data-testid="review-download"
        disabled={!snap.state}
        onClick={download}
      >
        Download decision file
      </button>
      <details>
        <summary>Preview</summary>
        <pre class="we-review-json" data-testid="review-decision-json">
          {json}
        </pre>
      </details>
    </section>
  );
}

export function ChangesPanel({ host }: PluginProps) {
  const snap = useEditor(host);
  const store = useReview(host);
  const current = snap.state?.revision ?? 0;
  const entries = [...snap.history].reverse();
  const s = store.summary();
  const entry = store.inspectedEntry();
  const showingBefore = entry !== null && snap.state?.revision === entry.revision - 1;
  const busy = store.ui.working !== null || snap.busy;
  return (
    <div class="we-review-panel" data-testid="review-panel" ref={registerPanel}>
      <div class="we-review-nav" role="toolbar" aria-label="History stepping">
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Previous change (revision - 1)"
          aria-label="Previous change"
          data-testid="review-prev"
          disabled={busy || current <= 0}
          onClick={() => void store.stepBy(-1)}
        >
          Previous
        </button>
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Next change (revision + 1)"
          aria-label="Next change"
          data-testid="review-next"
          disabled={busy || current >= snap.history.length}
          onClick={() => void store.stepBy(1)}
        >
          Next
        </button>
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Back to the original document (revision 0)"
          aria-label="Back to original"
          data-testid="review-original"
          disabled={busy || current <= 0}
          onClick={() => void store.step(0)}
        >
          Back to original
        </button>
        <button
          type="button"
          class="we-btn we-btn--small we-btn--outline"
          title="Flip between before and after of the inspected change set"
          aria-label="Before and after"
          aria-pressed={showingBefore}
          data-testid="review-flip"
          disabled={busy || entry === null}
          onClick={() => void store.flip()}
        >
          {showingBefore ? "Showing before" : "Showing after"}
        </button>
        <CompareToggle host={host} />
      </div>
      <div class="we-review-summary" data-testid="review-summary" aria-live="polite">
        {`${s.approve} approved, ${s.reject} rejected, ${s.undecided} undecided`}
      </div>
      <div class="we-review-rev" data-testid="review-revision">{`Revision ${current} of ${snap.history.length}`}</div>
      {store.ui.working ? (
        <div class="we-notice we-notice--info" data-testid="review-working">
          {store.ui.working}...
        </div>
      ) : null}
      {store.ui.notice && !store.ui.coupled ? (
        <div
          class={`we-notice${store.ui.failure ? " we-notice--error" : " we-notice--info"}`}
          role="status"
          data-testid="review-notice"
        >
          {store.ui.notice}
        </div>
      ) : null}
      <CoupledNotice store={store} />
      <ol
        class="we-review-entries"
        data-testid="review-entries"
        aria-label="Change sets"
        onKeyDown={(e) => handleListKey(e, host)}
      >
        {entries.map((e) => (
          <Entry key={`${e.revision}:${e.resultSha256}`} store={store} entry={e} current={current} />
        ))}
        {entries.length === 0 ? (
          <li class="we-review-muted" data-testid="review-empty">
            No changes yet.
          </li>
        ) : null}
      </ol>
      {store.dropped.length ? (
        <details class="we-review-section">
          <summary>{`Rejected and removed (${store.dropped.length})`}</summary>
          <ul data-testid="review-dropped">
            {store.dropped.map((d) => (
              <li
                key={`${d.entry.revision}:${d.entry.resultSha256}`}
              >{`${d.entry.label} - ${d.entry.source} - ${countsText(changesOf(d.entry))}`}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {snap.history.length ? <PartsSection store={store} busy={busy} /> : null}
      {store.mode === "review" && store.hasSubmitHandler ? <SubmitBox store={store} /> : null}
      <ExportBox store={store} host={host} />
      {store.mode === "review" ? null : <ManualOps store={store} />}
    </div>
  );
}
