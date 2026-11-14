import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Address, DocState, TypedValue, ViewNode } from "@wolfsdk/protocol";
import type { EditorHost, EditorSnapshot } from "../host/index.ts";

const ROW_HEIGHT = 22;
const ROW_OVERSCAN = 12;

type Row = { id: Address; depth: number; hasChildren: boolean; open: boolean };

/** The single member of a typed value as display text (`{ number: 91 }` -> `91`). */
function valueText(value: TypedValue): string {
  if ("empty" in value) return "";
  const [member] = Object.values(value) as (string | number | boolean)[];
  return String(member);
}

/** One-line description of a node for the tree. */
function summary(node: ViewNode): string {
  if (node.label) return node.label;
  if (node.text) return node.text.length > 80 ? `${node.text.slice(0, 80)}\u2026` : node.text;
  if (node.formula) return node.formula;
  if (node.value) return valueText(node.value);
  return "";
}

function matches(node: ViewNode, query: string): boolean {
  return (
    node.id.toLowerCase().includes(query) ||
    !!node.text?.toLowerCase().includes(query) ||
    !!node.label?.toLowerCase().includes(query) ||
    !!node.a1?.toLowerCase().includes(query) ||
    !!node.formula?.toLowerCase().includes(query) ||
    (!!node.value && valueText(node.value).toLowerCase().includes(query))
  );
}

export function Inspector({ host, snapshot }: { host: EditorHost; snapshot: EditorSnapshot }) {
  const { state, selection } = snapshot;
  if (!state) {
    return (
      <div class="we-shell-inspector-empty" data-testid="shell-inspector-empty">
        No document open.
      </div>
    );
  }
  return (
    <div class="we-shell-inspector" data-testid="shell-inspector">
      <NodeTree key={state.doc} host={host} state={state} selection={selection} />
      <NodeDetails host={host} state={state} selection={selection} />
    </div>
  );
}

type TreeProps = { host: EditorHost; state: DocState; selection: Address[] };

function NodeTree({ host, state, selection }: TreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<Address>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();

  const { rows, hits } = useMemo(() => {
    // While searching, show matches and their ancestors, fully expanded.
    let include: Set<Address> | null = null;
    let hits = 0;
    if (q) {
      include = new Set();
      for (const node of state.nodes) {
        if (!matches(node, q)) continue;
        hits++;
        let id: Address | null | undefined = node.id;
        while (id && !include.has(id)) {
          include.add(id);
          id = host.node(id)?.parent;
        }
      }
    }
    const rows: Row[] = [];
    const top = state.childIds[""] ?? [];
    const stack: [Address, number][] = top.map((id): [Address, number] => [id, 0]).reverse();
    while (stack.length) {
      const [id, depth] = stack.pop()!;
      if (include && !include.has(id)) continue;
      const children = state.childIds[id] ?? [];
      const open = include ? true : expanded.has(id);
      rows.push({ id, depth, hasChildren: children.length > 0, open });
      if (open) for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, depth + 1]);
    }
    return { rows, hits };
  }, [state, expanded, q, host]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A selection made elsewhere expands its ancestors and scrolls its row into view.
  const primary = selection[0];
  const revealed = useRef<Address | undefined>(undefined);
  // Leaving or changing a search re-reveals the primary selection in the full tree.
  useLayoutEffect(() => {
    revealed.current = undefined;
  }, [q]);
  useEffect(() => {
    if (!primary || primary === revealed.current) return;
    const ancestors: Address[] = [];
    for (let id = host.node(primary)?.parent; id; id = host.node(id)?.parent) ancestors.push(id);
    if (ancestors.some((a) => !expanded.has(a))) setExpanded((prev) => new Set([...prev, ...ancestors]));
  }, [primary, q]);
  useEffect(() => {
    if (!primary || primary === revealed.current) return;
    const index = rows.findIndex((r) => r.id === primary);
    if (index < 0) return;
    revealed.current = primary;
    const el = ref.current!;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }
  }, [rows, primary]);

  function toggle(id: Address) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function onRowClick(event: MouseEvent, id: Address) {
    revealed.current = id;
    if (event.shiftKey) {
      host.select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
    } else host.select([id]);
    host.reveal({ address: id });
  }

  const selected = new Set(selection);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + ROW_OVERSCAN);

  return (
    <div class="we-shell-tree-wrap">
      <div class="we-shell-tree-search">
        <input
          type="search"
          placeholder="Search text or address"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          data-testid="shell-inspector-search"
          aria-label="Search nodes by text or address"
          title="Search nodes by text or address"
        />
        <span class="we-shell-muted" data-testid="shell-inspector-count">
          {q ? `${hits} match${hits === 1 ? "" : "es"}` : `${state.nodes.length} nodes`}
        </span>
      </div>
      <div
        class="we-shell-tree"
        role="tree"
        aria-label="Document nodes"
        data-testid="shell-inspector-tree"
        ref={ref}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: `${rows.length * ROW_HEIGHT}px`, position: "relative" }}>
          {rows.slice(first, last).map((row, i) => {
            const node = host.node(row.id);
            const hidden = node && !node.visible;
            return (
              <div
                key={row.id}
                class={`we-shell-tree-row${selected.has(row.id) ? " we-shell-tree-row-selected" : ""}${
                  row.id === primary ? " we-shell-tree-row-primary" : ""
                }${hidden ? " we-shell-tree-row-hidden" : ""}`}
                style={{ top: `${(first + i) * ROW_HEIGHT}px`, paddingLeft: `${4 + row.depth * 14}px` }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={selected.has(row.id)}
                aria-expanded={row.hasChildren ? row.open : undefined}
                title={hidden ? `${row.id} (hidden: ${node?.hidden_reason ?? "unknown"})` : row.id}
                data-testid={`shell-tree-row-${row.id}`}
                onClick={(e) => onRowClick(e, row.id)}
                onDblClick={() => row.hasChildren && !q && toggle(row.id)}
              >
                {row.hasChildren && !q ? (
                  <button
                    class="we-shell-twisty"
                    title={row.open ? "Collapse" : "Expand"}
                    aria-label={row.open ? `Collapse ${row.id}` : `Expand ${row.id}`}
                    data-testid={`shell-tree-toggle-${row.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(row.id);
                    }}
                  >
                    {row.open ? "\u25BE" : "\u25B8"}
                  </button>
                ) : (
                  <span class="we-shell-twisty-space" />
                )}
                <span class="we-shell-kind">{node?.kind ?? "?"}</span>
                <span class="we-shell-tree-text">{node ? summary(node) : ""}</span>
                <span class="we-shell-tree-id">{row.id}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function memberText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function NodeDetails({ host, state, selection }: TreeProps) {
  const id = selection[0];
  if (!id) {
    return (
      <div class="we-shell-details we-shell-muted" data-testid="shell-inspector-details">
        Select an object on a page or in the tree.
      </div>
    );
  }
  const node = host.node(id);
  if (!node) {
    return (
      <div class="we-shell-details" data-testid="shell-inspector-details">
        <code>{id}</code> is not in the current view.
      </div>
    );
  }
  const pages = [...new Set(state.regions.filter((r) => r.object_id === id).map((r) => r.page))];
  const unrendered = state.unrendered.includes(id);
  return (
    <div class="we-shell-details" data-testid="shell-inspector-details">
      <div class="we-shell-details-head">
        <span class="we-shell-kind" data-testid="shell-detail-kind">
          {node.kind}
        </span>
        <code class="we-shell-details-address" data-testid="shell-detail-address">
          {node.id}
        </code>
        <button
          class="we-btn we-btn--small"
          title="Copy address"
          aria-label="Copy address"
          data-testid="shell-copy-address"
          onClick={() => void navigator.clipboard?.writeText(node.id)}
        >
          Copy
        </button>
      </div>
      {selection.length > 1 && (
        <div class="we-shell-muted" data-testid="shell-detail-multi">
          {selection.length} selected; showing the first.
        </div>
      )}
      <div class="we-shell-muted" data-testid="shell-detail-pages">
        {pages.length ? (
          <>
            {pages.length > 1 ? "Drawn on pages " : "Drawn on page "}
            {pages.map((page, i) => (
              <Fragment key={page}>
                {i > 0 && ", "}
                <button
                  class="we-shell-link"
                  title={`Show page ${page}`}
                  aria-label={`Show page ${page}`}
                  data-testid={`shell-detail-page-${page}`}
                  onClick={() => host.reveal({ page })}
                >
                  {page}
                </button>
              </Fragment>
            ))}
          </>
        ) : unrendered ? (
          "On a rendered page without its own region"
        ) : (
          "No region in this render"
        )}
      </div>
      {!!node.text && (
        <div class="we-shell-details-text" data-testid="shell-detail-text">
          {node.text}
        </div>
      )}
      <table class="we-shell-members">
        <tbody>
          {Object.entries(node).map(([key, value]) => (
            <tr key={key} data-testid={`shell-detail-member-${key}`}>
              <th scope="row">{key}</th>
              <td>{memberText(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
