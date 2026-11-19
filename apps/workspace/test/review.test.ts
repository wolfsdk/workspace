import { describe, expect, test } from "bun:test";
import type { DocState } from "@wolfsdk/protocol/contract";
import * as model from "@wolfsdk/protocol/session";
import type { RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { batchFromSession, isActivityFor, isDecided, isOwnCommit, isOwnNewProposal, outcomeOf, reviewInputOf } from "../src/lib/review.ts";
import { ALICE, batch, entry, head, proposal, SCOUT } from "./fixtures.ts";

describe("reviewInputOf", () => {
  test("opens the proposal over the base, one labelled batch each, with the clock and zone it ran under", () => {
    const base = new Uint8Array([1, 2, 3]);
    const p = proposal("p1", "memo.docx", { batches: [batch(2, "Tighten the summary"), batch(1)] });
    const input = reviewInputOf(p, base);
    expect(input.base).toBe(base);
    expect(input.name).toBe("memo.docx");
    expect(input.batches).toEqual([
      { ops: p.batches[0]!.ops as never, label: "Tighten the summary", clock: "2026-11-13T18:00:00Z", timezone: "America/Los_Angeles" },
      { ops: p.batches[1]!.ops as never, label: "Change 2 of p1", clock: "2026-11-13T18:00:00Z", timezone: "America/Los_Angeles" },
    ]);
  });
});

describe("batchFromSession", () => {
  const session = {
    locale: "en-US",
    batches: [
      { ops: [{ op: "set", address: "/a", value: 1 }], baseSha256: "x", resultSha256: "y" },
      { ops: [{ op: "delete", address: "/b" }], baseSha256: "y", resultSha256: "z" },
    ],
  } as never;

  test("joins the local batches into one, in order, with the label and locale", () => {
    expect(batchFromSession(session, "  Fix totals ")).toEqual({
      ops: [
        { op: "set", address: "/a", value: 1 },
        { op: "delete", address: "/b" },
      ],
      label: "Fix totals",
      locale: "en-US",
    });
  });

  test("leaves out an empty label, and is null without ops", () => {
    expect(batchFromSession(session, "")).not.toHaveProperty("label");
    expect(batchFromSession({ locale: "en-US", batches: [] } as never, "x")).toBeNull();
  });
});

describe("outcomeOf", () => {
  test("approves only when every change is approved and rejects only when every change is rejected", () => {
    expect(outcomeOf({ approve: 3, reject: 0, undecided: 0 })).toBe("approve");
    expect(outcomeOf({ approve: 0, reject: 2, undecided: 0 })).toBe("reject");
    expect(outcomeOf({ approve: 1, reject: 1, undecided: 0 })).toBe("mixed");
    expect(outcomeOf({ approve: 1, reject: 0, undecided: 1 })).toBe("incomplete");
  });
});

describe("event matchers", () => {
  const committed: RoomServerEvent = { type: "doc.committed", seq: 5, head: head("memo.docx", 3), entry: entry(5, "memo.docx", 3) };

  test("isOwnCommit wants this actor, this document and the next revision", () => {
    expect(isOwnCommit(committed, ALICE.id, "memo.docx", 2)).toBe(true);
    expect(isOwnCommit(committed, ALICE.id, "memo.docx", 1)).toBe(false);
    expect(isOwnCommit(committed, SCOUT.id, "memo.docx", 2)).toBe(false);
    expect(isOwnCommit(committed, ALICE.id, "other.docx", 2)).toBe(false);
  });

  test("isOwnNewProposal wants an open proposal of this actor that was not known", () => {
    const event: RoomServerEvent = { type: "proposal.updated", seq: 6, proposal: proposal("p9", "memo.docx", { author: ALICE }) };
    expect(isOwnNewProposal(event, ALICE.id, "memo.docx", new Set())).toBe(true);
    expect(isOwnNewProposal(event, ALICE.id, "memo.docx", new Set(["p9"]))).toBe(false);
    expect(isOwnNewProposal(event, SCOUT.id, "memo.docx", new Set())).toBe(false);
  });

  test("isDecided wants the proposal taking the decision that was asked", () => {
    const updated = (id: string, status?: "approved" | "rejected" | "conflicted") =>
      ({ type: "proposal.updated", seq: 7, proposal: proposal(id, "memo.docx", status ? { status } : {}) }) as const;
    expect(isDecided(updated("p1", "approved"), "p1", "approve")).toBe(true);
    expect(isDecided(updated("p1", "rejected"), "p1", "reject")).toBe(true);
    expect(isDecided(updated("p1"), "p1", "approve")).toBe(false);
    expect(isDecided(updated("p2", "rejected"), "p1", "reject")).toBe(false);
    // An approval the engine refuses closes the proposal as conflicted: that is not an approval.
    expect(isDecided(updated("p1", "conflicted"), "p1", "approve")).toBe(false);
  });

  test("isActivityFor takes the document's activity and room-wide activity", () => {
    const at = "2026-11-13T18:00:00Z";
    const agent = { id: "scout", name: "Scout" };
    expect(isActivityFor({ type: "agent.activity", seq: 1, agent, doc_name: "memo.docx", activity: "reading", at }, "memo.docx")).toBe(true);
    expect(isActivityFor({ type: "agent.activity", seq: 1, agent, doc_name: null, activity: "searching", at }, "memo.docx")).toBe(true);
    expect(isActivityFor({ type: "agent.activity", seq: 1, agent, doc_name: "model.xlsx", activity: "reading", at }, "memo.docx")).toBe(false);
    expect(isActivityFor(committed, "memo.docx")).toBe(false);
  });
});

describe("a deck proposal's table cell edit", () => {
  // As the engine views a slide holding a 2 x 2 table (the walkthrough deck's has 5 x 5): regions for the
  // slide and the table shape only, none per cell. The edit's diff names the cell, its paragraph and its run.
  const table = "slide:#257/shape:#3";
  const cell = `${table}/row:@2/cell:@2`;
  const node = (id: string, kind: string, parent: string | null, extra: object = {}) => ({ id, kind, parent, visible: true, ...extra });
  const nodes = [
    node("slide:#257", "slide", null),
    node(table, "shape", "slide:#257", { geometry: { x: 548640, y: 1005840, cx: 8046720, cy: 2286000 } }),
    node(`${table}/col:@1`, "col", table, { value: { number: 4023360 } }),
    node(`${table}/col:@2`, "col", table, { value: { number: 4023360 } }),
    node(`${table}/row:@1`, "row", table, { value: { number: 1143000 } }),
    node(`${table}/row:@1/cell:@1`, "cell", `${table}/row:@1`),
    node(`${table}/row:@1/cell:@2`, "cell", `${table}/row:@1`),
    node(`${table}/row:@2`, "row", table, { value: { number: 1143000 } }),
    node(`${table}/row:@2/cell:@1`, "cell", `${table}/row:@2`),
    node(cell, "cell", `${table}/row:@2`),
  ];
  const childIds: Record<string, string[]> = {};
  for (const n of nodes) (childIds[n.parent ?? ""] ??= []).push(n.id);
  const px = 1500 / 720;
  const region = (object_id: string, bbox_pt: [number, number, number, number]) => ({
    object_id,
    page: 3,
    bbox_pt,
    bbox_px: bbox_pt.map((v) => v * px) as [number, number, number, number],
  });
  const state = {
    doc: "d1",
    name: "walkthrough.pptx",
    format: "pptx",
    revision: 1,
    sha256: "after",
    nodes,
    childIds,
    regions: [region("slide:#257", [0, 0, 720, 540]), region(table, [43.2, 79.2, 633.6, 180])],
  } as unknown as DocState;
  const modified = (address: string, kind: string) => ({ address, change: "modified" as const, kind, parts: ["ppt/slides/slide3.xml"], property: "text" });
  const edit = {
    revision: 1,
    label: "Proposed change 1",
    source: "proposal",
    ops: [],
    diff: [modified(cell, "cell"), modified(`${cell}/para:@1`, "paragraph"), modified(`${cell}/para:@1/run:@1`, "run")],
    transaction: {},
    baseSha256: "before",
    resultSha256: "after",
    appliedAt: 0,
  } as unknown as model.HistoryEntry;

  test("outlines the changed cell, as a changed Word table cell is", () => {
    expect(model.outlined(edit, 0, state)).toBe(true);
  });

  test("draws the cell's outline in the cell's box on the slide, tagged modified", () => {
    const boxes = model.boxesOnPage(edit, "after", [...state.regions, ...model.tableCellRegions(state)]);
    expect(boxes.map((b) => [b.address, b.change.change, b.region.page, b.region.bbox_pt])).toEqual([
      [cell, "modified", 3, [43.2 + 316.8, 79.2 + 90, 316.8, 90]],
    ]);
  });
});
