// Room values for the tests, small and valid against `wolfsdk.room.v1`.
import type { RoomActor, RoomHead, RoomPinnedBatch, RoomProposal, RoomServerEvent, RoomSessionEntry, RoomState, RoomThread } from "@wolfsdk/protocol/workspace";

export const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice Chen" };
export const SCOUT: RoomActor = { kind: "agent", id: "scout", name: "Scout" };

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

export function head(name: string, revision = 0, sha256 = SHA_A): RoomHead {
  const format = name.endsWith(".xlsx") ? "xlsx" : name.endsWith(".pptx") ? "pptx" : name.endsWith(".pdf") ? "pdf" : "docx";
  return { name, revision, sha256, format, updated_at: "2026-11-13T18:00:00Z" };
}

export function batch(ops = 1, label?: string): RoomPinnedBatch {
  return {
    ops: Array.from({ length: ops }, (_, i) => ({ op: "set", address: `/body/p[${i + 1}]`, value: `v${i}` })),
    ...(label ? { label } : {}),
    clock: "2026-11-13T18:00:00Z",
    timezone: "America/Los_Angeles",
    locale: "en-US",
    seed: 7,
  };
}

export function proposal(id: string, doc: string, over: Partial<RoomProposal> = {}): RoomProposal {
  return {
    proposal_id: id,
    doc_name: doc,
    base_revision: 0,
    author: SCOUT,
    status: "open",
    batches: [batch(2, "Tighten the summary")],
    preview_sha256: SHA_B,
    created_at: "2026-11-13T18:10:00Z",
    ...over,
  };
}

export function entry(seq: number, doc: string, revision: number, over: Partial<RoomSessionEntry> = {}): RoomSessionEntry {
  return {
    seq,
    doc_name: doc,
    revision,
    base_sha256: SHA_A,
    result_sha256: SHA_B,
    author: ALICE,
    batch: batch(1, "Fix a typo"),
    proposal_id: null,
    approved_by: null,
    committed_at: "2026-11-13T18:20:00Z",
    ...over,
  };
}

export function thread(id: string, doc: string, over: Partial<RoomThread> = {}): RoomThread {
  return {
    thread_id: id,
    doc_name: doc,
    target_address: "/body/p[1]",
    mentions: [],
    messages: [{ message_id: `${id}-m1`, author: ALICE, body: "Check this", created_at: "2026-11-13T18:30:00Z" }],
    resolved: false,
    ...over,
  };
}

export function room(over: Partial<RoomState> = {}): RoomState {
  return {
    contract: "wolfsdk.room.v1",
    room_id: "q3-close",
    workspace_id: "default",
    seq: 10,
    documents: [{ head: head("memo.docx") }, { head: head("model.xlsx", 2) }],
    session_log: [],
    proposals: [],
    comments: [],
    ...over,
  };
}

/** A `display_list` response of the reactor ABI: one page of 612 x 792 pt with a filled shape and a line of text. */
export function displayListPage(page: number, text: string): Record<string, unknown> {
  return {
    ok: true,
    page,
    ir: {
      size: { width: 612, height: 792 },
      label: `Page ${page}`,
      ops: [
        {
          fill: {
            path: [{ move_to: { x: 72, y: 72 } }, { line_to: { x: 272, y: 72 } }, { line_to: { x: 272, y: 172 } }, "close"],
            paint: { solid: { r: 20, g: 40, b: 80, a: 255 } },
            fill_rule: "non_zero",
          },
        },
        {
          glyph_run: {
            font: 0,
            size: 12,
            origin: { x: 72, y: 100 },
            fill: { solid: { r: 0, g: 0, b: 0, a: 255 } },
            shaping: "pending",
            text,
            object_id: `p:${page}`,
            object_offset: 0,
          },
        },
      ],
    },
    runs: [{ run: 0, object_id: `p:${page}`, object_offset: 0, char_x: [72, 79, 86], bbox: [72, 88, 14, 16] }],
    fonts: [{ id: 0, family: "Inter", weight: 400, style: "normal" }],
    images: [],
    objects: { [`p:${page}`]: { text, rendered: text, source_text: true } },
    regions: [{ object_id: `p:${page}`, bbox: [72, 88, 14, 16] }],
  };
}

/** The bytes of a snapshot as the server sends them: UTF-8 JSON, `{ "pages": [...] }`, one `display_list` response per page. */
export const snapshotBytes = (...pages: Record<string, unknown>[]): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify({ pages }));

export function activityEvent(
  seq: number,
  agent: { id: string; name: string },
  activity: Extract<RoomServerEvent, { type: "agent.activity" }>["activity"],
  doc: string | null,
  detail?: string,
): Extract<RoomServerEvent, { type: "agent.activity" }> {
  return { type: "agent.activity", seq, agent, doc_name: doc, activity, ...(detail ? { detail } : {}), at: "2026-11-13T18:40:00Z" };
}
