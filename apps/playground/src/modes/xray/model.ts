/**
 * Pure X-ray model. Everything here works on engine output only: findings
 * from `engine.findings(doc)` and view nodes from `doc.nodes` (observe).
 * Nothing decides in JavaScript whether content is hidden.
 */
import type { Finding, ViewNode } from "../../lab/index.ts";

export type FindingKind = Finding["kind"];
export type Bbox = [number, number, number, number];
export type LocatedFinding = Finding & { page: number; bboxPt: Bbox };

export const KIND_ORDER: readonly FindingKind[] = ["hidden", "tracked", "comment", "notes", "alt-text"];

export const KIND_LABEL: Record<FindingKind, string> = {
  hidden: "Hidden content",
  tracked: "Tracked changes",
  comment: "Comments",
  notes: "Speaker notes",
  "alt-text": "Alt text",
};

/** Short tag used inline next to a hidden span. */
export const KIND_TAG: Record<FindingKind, string> = {
  hidden: "hidden",
  tracked: "tracked",
  comment: "comment",
  notes: "notes",
  "alt-text": "alt text",
};

export type FindingGroup = { key: string; kind: FindingKind; reason: string; findings: Finding[] };

/** Findings grouped by kind, then by the engine's reason string. Kinds follow
 * `KIND_ORDER`; reasons and findings keep the engine's order. */
export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = `${finding.kind}\u0000${finding.reason}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, kind: finding.kind, reason: finding.reason, findings: [] };
      groups.set(key, group);
    }
    group.findings.push(finding);
  }
  return [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** The engine placed this finding on a rendered page. */
export function isLocated(finding: Finding): finding is LocatedFinding {
  return finding.page !== undefined && finding.bboxPt !== undefined;
}

export function locatedOnPage(findings: readonly Finding[], page: number): LocatedFinding[] {
  return findings.filter((f): f is LocatedFinding => isLocated(f) && f.page === page);
}

/** Centre of a box as a percentage of the page, clamped to the page. */
export function bboxCentre(bbox: Bbox, widthPt: number, heightPt: number): { x: number; y: number } {
  const [x, y, w, h] = bbox;
  return { x: clampPct(((x + w / 2) / widthPt) * 100), y: clampPct(((y + h / 2) / heightPt) * 100) };
}

/** True when no part of the box lies on the page. */
export function bboxOffPage(bbox: Bbox, widthPt: number, heightPt: number): boolean {
  const [x, y, w, h] = bbox;
  return x >= widthPt || y >= heightPt || x + w <= 0 || y + h <= 0;
}

export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// What a text parser hands your model
// ---------------------------------------------------------------------------

export type ParserSegment = {
  address: string;
  text: string;
  /** Findings this span belongs to. Empty for visible text. */
  findings: Finding[];
  /** False for findings that match no observe node: listed after the
   * reading-order text. */
  placed: boolean;
};

export type ParserText = { segments: ParserSegment[]; plain: string };

/** Text of one node as observe wrote it: `text`, else a cell's typed value. */
export function nodeText(node: ViewNode): string {
  if (node.text) return node.text;
  const value = node.value;
  if (!value) return "";
  if ("string" in value) return value.string;
  if ("text" in value) return value.text;
  if ("number" in value) return String(value.number);
  if ("boolean" in value) return String(value.boolean);
  return "";
}

/**
 * Assemble the text a parser would hand a model, in observe's node order.
 *
 * Observe repeats text at several levels (cell, paragraph, run). A text node
 * starts a span unless its nearest text-bearing ancestor covers it: same
 * channel and same effective visibility (a node is effectively visible only
 * when it and every ancestor are visible). So a comment or tracked deletion
 * under a paragraph gets its own span, and runs under a hidden paragraph stay
 * in that paragraph's span.
 *
 * A span is marked hidden only by findings: a finding on the span's node, on
 * a node it covers, or on an ancestor (a hidden sheet marks its cells).
 * Findings that match no node are appended, unplaced, in engine order.
 */
export function assembleParserText(nodes: readonly ViewNode[], findings: readonly Finding[]): ParserText {
  const byId = new Map<string, ViewNode>();
  for (const node of nodes) byId.set(node.id, node);

  const findingsAt = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = findingsAt.get(finding.address);
    if (list) list.push(finding);
    else findingsAt.set(finding.address, [finding]);
  }

  const visibility = new Map<string, boolean>();
  const effectiveVisible = (node: ViewNode, depth = 0): boolean => {
    const known = visibility.get(node.id);
    if (known !== undefined) return known;
    const parent = node.parent ? byId.get(node.parent) : undefined;
    const value = node.visible && (parent && depth < nodes.length ? effectiveVisible(parent, depth + 1) : true);
    visibility.set(node.id, value);
    return value;
  };

  const segments: ParserSegment[] = [];
  const segmentOf = new Map<string, ParserSegment>();
  const used = new Set<Finding>();
  const attach = (segment: ParserSegment, list: Finding[] | undefined) => {
    for (const finding of list ?? []) {
      if (used.has(finding)) continue;
      used.add(finding);
      segment.findings.push(finding);
    }
  };

  for (const node of nodes) {
    const own = findingsAt.get(node.id);
    const ownText = nodeText(node);
    const text = ownText || (own?.find((f) => f.text)?.text ?? "");
    if (!text) continue;

    // Nearest ancestor that started a span, and whether it covers this node.
    let ancestor: ParserSegment | undefined;
    let ancestorNode: ViewNode | undefined;
    let inherited: Finding[] | undefined;
    for (let id = node.parent, hops = 0; id && hops < nodes.length; hops++) {
      const parent = byId.get(id);
      if (!parent) break;
      if (!inherited && findingsAt.has(parent.id)) inherited = findingsAt.get(parent.id);
      const seg = segmentOf.get(parent.id);
      if (seg && !ancestor) {
        ancestor = seg;
        ancestorNode = parent;
      }
      id = parent.parent;
    }

    if (
      ancestor &&
      ancestorNode &&
      (ancestorNode.channel ?? "body") === (node.channel ?? "body") &&
      effectiveVisible(ancestorNode) === effectiveVisible(node)
    ) {
      attach(ancestor, own);
      segmentOf.set(node.id, ancestor);
      continue;
    }

    const segment: ParserSegment = { address: node.id, text, findings: [], placed: true };
    attach(segment, own);
    if (segment.findings.length === 0 && inherited) segment.findings.push(...inherited);
    for (const finding of inherited ?? []) used.add(finding);
    segments.push(segment);
    // A span whose text came from a finding, not from the node, covers nothing:
    // its descendants carry their own text.
    if (ownText) segmentOf.set(node.id, segment);
  }

  for (const finding of findings) {
    if (used.has(finding) || !finding.text) continue;
    segments.push({ address: finding.address, text: finding.text, findings: [finding], placed: false });
  }

  return { segments, plain: segments.map((s) => s.text).join("\n") };
}
