import type { DocFormat, Finding, Region, ViewNode } from "./types.ts";

/**
 * Content the reader does not see, from `observe` output only. Pure: no
 * kernel, no DOM, no state. Ids are `observe:<kind>:<node id>`, so two runs
 * over the same view produce the same ids.
 *
 * - Hidden: `visible === false` with a `hidden_reason`. The engine's reason is
 *   the finding's reason.
 * - Comments, notes, alt text and visible revisions are labelled by channel or
 *   field, never by colour, size or geometry.
 * - `page` and `bboxPt` are set only when the flagged node itself has a region.
 * - `granularity: "container"` when the flagged node has a visible child (the
 *   engine marks a whole paragraph, not the hidden run).
 */
export type FindingsInput = {
  format: DocFormat;
  nodes: ViewNode[];
  regions: Region[];
};

export function findingsFromView(input: FindingsInput): Finding[] {
  const doc = input;
  const regionOf = new Map<string, Region>();
  for (const region of doc.regions) if (!regionOf.has(region.object_id)) regionOf.set(region.object_id, region);
  const visibleChild = new Set<string>();
  for (const node of doc.nodes) if (node.visible && node.parent !== null) visibleChild.add(node.parent);

  const out: Finding[] = [];
  for (const node of doc.nodes) {
    const classified = classify(node);
    if (!classified) continue;
    const finding: Finding = {
      id: `observe:${classified.kind}:${node.id}`,
      kind: classified.kind,
      reason: classified.reason,
      address: node.id,
      source: "observe",
    };
    const region = regionOf.get(node.id);
    if (region) {
      finding.page = region.page;
      finding.bboxPt = region.bbox_pt;
    }
    const text = textOf(node, classified.kind);
    if (text !== undefined) {
      finding.text = text;
      finding.chars = [...text].length;
    }
    if (classified.kind === "hidden" && visibleChild.has(node.id)) finding.granularity = "container";
    out.push(finding);
  }
  return out;
}

function textOf(node: ViewNode, kind: Finding["kind"]): string | undefined {
  if (kind === "alt-text") return node.alt_text;
  return typeof node.text === "string" ? node.text : undefined;
}

function classify(node: ViewNode): { kind: Finding["kind"]; reason: string } | null {
  if (!node.visible) {
    const reason = node.hidden_reason;
    if (typeof reason !== "string" || reason === "") return null;
    return { kind: reason.includes("tracked") ? "tracked" : "hidden", reason };
  }
  if (node.channel === "comments" && (node.kind === "comment" || node.kind === "reply")) {
    return { kind: "comment", reason: "comments" };
  }
  if (node.kind === "notes" && node.channel === "notes") return { kind: "notes", reason: "notes" };
  if (node.kind === "revision" && typeof node.channel === "string") return { kind: "tracked", reason: node.channel };
  if (typeof node.alt_text === "string" && node.alt_text !== "") {
    return { kind: "alt-text", reason: "alt_text" };
  }
  return null;
}
