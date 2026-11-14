/** @jsxImportSource preact */
import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { documentSummaries } from "../src/lib/room-state.ts";
import { LeftRail, type LeftRailProps } from "../src/ui/left-rail.tsx";
import { RightRail, type RightRailProps } from "../src/ui/right-rail.tsx";
import { filterItems, type SwitcherItem } from "../src/ui/switcher.tsx";
import { ALICE, entry, head, proposal, room, SCOUT, thread } from "./fixtures.ts";

const noop = (): void => undefined;

function rightRail(over: Partial<RightRailProps> = {}): string {
  const props: RightRailProps = {
    tab: "proposals",
    onTab: noop,
    actor: ALICE,
    activeDoc: "memo.docx",
    allDocs: false,
    onAllDocs: noop,
    proposals: [proposal("p1", "memo.docx"), proposal("p0", "memo.docx", { status: "approved" })],
    focusedProposal: null,
    deciding: null,
    onInspect: noop,
    onDecide: noop,
    onDownloadPreview: noop,
    threads: [thread("t1", "memo.docx")],
    selection: null,
    participants: [ALICE, SCOUT],
    onComment: async () => true,
    history: [entry(4, "memo.docx", 1, { approved_by: ALICE, author: SCOUT, proposal_id: "p0" })],
    activity: [],
    ...over,
  };
  return render(<RightRail {...props} />);
}

describe("RightRail", () => {
  test("a user gets Inspect Diff, Approve and Reject on open proposals only", () => {
    const html = rightRail();
    expect(html.match(/Inspect Diff/g)).toHaveLength(1);
    expect(html.match(/>Approve</g)).toHaveLength(1);
    expect(html).not.toContain("Only a user can");
    expect(html).toContain("Approved");
    expect(html).toContain("1 batch, 2 ops on r0");
  });

  test("an agent sees the decide controls disabled, with the reason", () => {
    const html = rightRail({ actor: SCOUT });
    expect(html).toContain("You are signed in as an agent. Only a user can approve or reject a proposal.");
    expect(html).toMatch(/disabled[^>]*title="Only a user can approve a proposal"|title="Only a user can approve a proposal"[^>]*disabled/);
  });

  test("shows times in 12-hour Pacific time", () => {
    expect(rightRail()).toMatch(/\d{1,2}:\d{2} (AM|PM) P[SD]T/);
  });

  test("comments offer the selection as an anchor and mention agents", () => {
    const html = rightRail({ tab: "comments", selection: "/body/p[4]" });
    expect(html).toContain("Anchor to selection");
    expect(html).toContain('title="Anchor to /body/p[4]"');
    expect(html).toContain("@scout");
    expect(html).toContain("Resolve");
  });

  test("a resolved thread offers Reopen instead of a reply box", () => {
    const html = rightRail({ tab: "comments", threads: [thread("t1", "memo.docx", { resolved: true })] });
    expect(html).toContain("Reopen");
    expect(html).not.toContain('placeholder="Reply"');
  });

  test("history shows the revision, the approver, the proposal and the short receipt", () => {
    const html = rightRail({ tab: "history" });
    expect(html).toContain("r1");
    expect(html).toContain("approved by <strong>Alice Chen</strong>");
    expect(html).toContain("p0");
    expect(html).toContain("sha256 bbbbbbbb");
  });

  test("an approved proposal names who approved it, across every document", () => {
    const bo: RoomActor = { kind: "user", id: "bo", name: "Bo Park" };
    const html = rightRail({
      allDocs: true,
      activeDoc: null,
      proposals: [
        proposal("p1", "memo.docx", { status: "approved" }),
        proposal("p2", "scan.pdf", { status: "approved" }),
        proposal("p3", "memo.docx", { status: "rejected" }),
        proposal("p4", "memo.docx"),
      ],
      history: [
        entry(4, "memo.docx", 1, { approved_by: ALICE, author: SCOUT, proposal_id: "p1" }),
        entry(5, "scan.pdf", 1, { approved_by: bo, author: SCOUT, proposal_id: "p2" }),
      ],
    });
    expect(html).toContain("approved by <strong>Alice Chen</strong>");
    expect(html).toContain("approved by <strong>Bo Park</strong>");
    // Only an approval is credited: the rejected and the open proposal name no approver.
    expect(html.match(/approved by/g)).toHaveLength(2);
  });

  test("a shared snapshot offers no Inspect Diff, since it has no engine, and keeps the decision controls", () => {
    const html = rightRail({ shareMode: true });
    expect(html).not.toContain("Inspect Diff");
    expect(html.match(/>Approve</g)).toHaveLength(1);
    expect(html.match(/>Reject</g)).toHaveLength(1);
  });

  test("uses no em dash", () => {
    for (const tab of ["proposals", "comments", "history"] as const) expect(rightRail({ tab })).not.toContain("\u2014");
  });
});

describe("LeftRail", () => {
  const props: LeftRailProps = {
    rooms: [{ room_id: "q3-close", workspace_id: "default", seq: 10 }],
    roomId: "q3-close",
    documents: documentSummaries(
      room({ documents: [{ head: head("memo.docx", 1) }, { head: head("scan.pdf") }], proposals: [proposal("p1", "memo.docx")] }),
    ),
    activeDoc: "memo.docx",
    pack: {
      dir: "pack",
      report: {
        pack_id: "q3-board",
        fresh: false,
        bindings: [
          { binding_id: "revenue", target_doc: "memo.docx", target_address: "/t", status: "stale", ops: 2, notes: [] },
          { binding_id: "margin", target_doc: "memo.docx", target_address: "/u", status: "fresh", ops: 0, notes: [] },
        ],
      },
    },
    packBusy: false,
    uploading: null,
    onSelectRoom: noop,
    onCreateRoom: async () => true,
    onSelectDoc: noop,
    onUpload: noop,
    onDownloadHead: noop,
    onRefreshPack: noop,
  };

  test("lists documents with format pills, revision and open-proposal badges", () => {
    const html = render(<LeftRail {...props} />);
    expect(html).toContain("DOCX");
    expect(html).toContain("PDF");
    expect(html).toContain(">r1<");
    expect(html).toContain('title="1 open proposals"');
    expect(html).toContain('aria-label="Download head of memo.docx"');
  });

  test("shows the linked pack with its stale bindings and Refresh Pack", () => {
    const html = render(<LeftRail {...props} />);
    expect(html).toContain("q3-board");
    expect(html).toContain("1 stale");
    expect(html).toContain("Refresh Pack");
  });

  test("hides the pack card without a linked pack", () => {
    expect(render(<LeftRail {...props} pack={null} />)).not.toContain("Linked pack");
  });
});

describe("filterItems", () => {
  const items: SwitcherItem[] = [
    { kind: "doc", id: "board-memo.docx", format: "docx", meta: "r1" },
    { kind: "doc", id: "model.xlsx", format: "xlsx", meta: "r2" },
    { kind: "room", id: "q3-close", meta: "Current room" },
  ];

  test("keeps items holding every word, in order given", () => {
    expect(filterItems(items, "").map((i) => i.id)).toEqual(["board-memo.docx", "model.xlsx", "q3-close"]);
    expect(filterItems(items, "MEMO docx").map((i) => i.id)).toEqual(["board-memo.docx"]);
    expect(filterItems(items, "q3").map((i) => i.kind)).toEqual(["room"]);
    expect(filterItems(items, "nothing")).toEqual([]);
  });
});
