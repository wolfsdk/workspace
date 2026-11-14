// `pack_link_refresh` of the served MCP endpoint: the pack of `--pack <dir>` is refreshed into the documents of
// the agent's room, over a real room server whose engine applies batches the way a local refresh does.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryStore, refreshPack } from "@wolfsdk/packs";
import type { PackBinding, RoomActor } from "@wolfsdk/protocol/workspace";
import { RoomServer } from "@wolfsdk/server";
import { LocalEngine } from "../../packs/test/evaluators.ts";
import { binding, docx, manifest, manifestBytes, partText, pptx, QUARTERS, sha256, STYLE, xlsx } from "../../packs/test/fixtures.ts";
import { startWorkspaceServer, tokenOf, type WorkspaceServer } from "../src/http.ts";

const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const TOKENS = new Map<string, RoomActor>([
  ["t-alice", ALICE],
  ["t-robot", ROBOT],
]);

const BINDINGS: PackBinding[] = [
  binding({ id: "docx-table", target_kind: "docx_table", target_address: "Revenue", selector: { type: "range", sheet: "Fin", ref: "A1:B4" }, fit_policy: "grow" }),
  binding({ id: "docx-headline", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" } }),
  binding({ id: "pptx-table", target_kind: "pptx_table", target_address: "slide:@1/shape:Table 1", selector: { type: "range", sheet: "Fin", ref: "A1:B3" }, fit_policy: "grow" }),
];

type BindingOutcome = { binding: string; status: string; doc?: string; proposal_id?: string; revision?: number; message?: string };
type Refreshed = { pack: string; mode: string; bindings: BindingOutcome[]; updated: number; failed: number };
type Called<T> = { result: { isError?: boolean; structuredContent: T } };
type Failed = { error: { code: string; message: string; detail?: { reason?: string } } };

let dir: string;
let pack: string;
let room: RoomServer;
let server: WorkspaceServer;
let headers: Record<string, string>;
let next = 10;

async function tool<T>(name: string, args: Record<string, unknown>): Promise<Called<T>> {
  const response = await fetch(`${server.mcpUrl}?room=r1`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: next++, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await response.json()) as Called<T>;
}

const headOf = async (name: string) => {
  const read = await room.readHead("r1", ALICE, name);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
};

async function writePack(bindings: PackBinding[] = BINDINGS): Promise<void> {
  await writeFile(join(pack, "pack.wolf.json"), manifestBytes(manifest(bindings)));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-workspace-pack-"));
  pack = join(dir, "pack");
  await mkdir(pack);
  await writePack();
  await writeFile(join(pack, "fin.xlsx"), xlsx({ rows: QUARTERS, names: { Headline: "Fin!$B$2" } }));
  await writeFile(join(pack, "deck.docx"), docx());
  await writeFile(join(pack, "deck.pptx"), pptx());
  room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new LocalEngine() });
  expect((await room.createRoom(ALICE, { room_id: "r1", workspace_id: "ws" })).ok).toBe(true);
  for (const [name, format, bytes] of [["deck.docx", "docx", docx()], ["deck.pptx", "pptx", pptx()]] as const) {
    expect((await room.addDocument("r1", ALICE, { name, format, bytes })).ok).toBe(true);
  }
  server = startWorkspaceServer({
    service: room,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (TOKENS.get(token) ?? null);
    },
    staticDir: null,
    pack: { dir: pack },
  });
  const opened = await fetch(`${server.mcpUrl}?room=r1`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer t-robot" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  expect(opened.status).toBe(200);
  headers = { authorization: "Bearer t-robot", "mcp-session-id": opened.headers.get("mcp-session-id") ?? "" };
});

afterEach(async () => {
  await server.stop();
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pack_link_refresh of the served MCP endpoint", () => {
  test("lists the linked pack and proposes its refresh into the room; once approved, the room holds what a local refresh writes", async () => {
    const listed = await tool<{ packs: unknown }>("workspace_list", {});
    expect(listed.result.structuredContent.packs).toEqual([{ pack: "quarterly", bindings: BINDINGS.map((b) => b.id), title: "Quarterly pack" }]);

    const diskBefore = sha256(new Uint8Array(await readFile(join(pack, "deck.docx"))));
    const proposed = await tool<Refreshed>("pack_link_refresh", { pack: "quarterly" });
    expect(proposed.result.isError).toBeUndefined();
    const outcome = proposed.result.structuredContent;
    expect(outcome).toMatchObject({ pack: "quarterly", mode: "propose", updated: 3, failed: 0 });
    expect(outcome.bindings.map((b) => [b.binding, b.status, b.doc])).toEqual([
      ["docx-table", "updated", "deck.docx"],
      ["docx-headline", "updated", "deck.docx"],
      ["pptx-table", "updated", "deck.pptx"],
    ]);
    // One proposal per document: both bindings of the Word document share theirs.
    const [table, headline, slide] = outcome.bindings;
    expect(table?.proposal_id).toBeString();
    expect(headline?.proposal_id).toBe(table?.proposal_id);
    expect(slide?.proposal_id).not.toBe(table?.proposal_id);
    expect((await headOf("deck.docx")).head.revision).toBe(0);
    expect((await headOf("deck.pptx")).head.revision).toBe(0);
    expect(sha256(new Uint8Array(await readFile(join(pack, "deck.docx"))))).toBe(diskBefore);

    for (const proposal_id of [table?.proposal_id, slide?.proposal_id]) {
      expect((await room.decideProposal("r1", ALICE, { proposal_id: proposal_id ?? "", decision: "approve" })).ok).toBe(true);
    }
    const local = new DirectoryStore(pack);
    await refreshPack(local);
    for (const name of ["deck.docx", "deck.pptx"]) {
      const head = await headOf(name);
      expect(head.head.revision).toBe(1);
      expect(sha256(head.bytes)).toBe(sha256((await local.read(name)) ?? new Uint8Array()));
    }

    const again = await tool<Refreshed>("pack_link_refresh", { pack: "quarterly" });
    expect(again.result.structuredContent).toMatchObject({ updated: 0, failed: 0 });
    expect(again.result.structuredContent.bindings.map((b) => b.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  test("refreshes only the bindings it is asked for, from the workbook of the room when the room holds one", async () => {
    const rows = [QUARTERS[0] ?? [], ["Q1", { v: 5000000, s: STYLE.currency }, { v: 0.5, s: STYLE.percent }], ...QUARTERS.slice(2)];
    expect((await room.addDocument("r1", ALICE, { name: "fin.xlsx", format: "xlsx", bytes: xlsx({ rows, names: { Headline: "Fin!$B$2" } }) })).ok).toBe(true);

    const committed = await tool<Refreshed>("pack_link_refresh", { pack: "quarterly", bindings: ["docx-headline"], mode: "commit" });
    expect(committed.result.structuredContent).toMatchObject({ mode: "commit", updated: 1, failed: 0 });
    expect(committed.result.structuredContent.bindings).toEqual([{ binding: "docx-headline", status: "updated", doc: "deck.docx", revision: 1 }]);
    const body = partText((await headOf("deck.docx")).bytes, "word/document.xml");
    expect(body).toContain("5,000,000");
    expect(body).not.toContain("1,234,567");
    expect((await headOf("deck.pptx")).head.revision).toBe(0);
  });

  test("names a pack or a binding it does not have, and a binding it cannot bring up to date, and writes nothing", async () => {
    const noPack = await tool<Failed>("pack_link_refresh", { pack: "other" });
    expect(noPack.result.isError).toBe(true);
    expect(noPack.result.structuredContent.error).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "pack-refresh" } });
    expect(noPack.result.structuredContent.error.message).toContain("quarterly");

    const noBinding = await tool<Failed>("pack_link_refresh", { pack: "quarterly", bindings: ["docx-headline", "nope"] });
    expect(noBinding.result.structuredContent.error).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "pack-refresh" } });
    expect(noBinding.result.structuredContent.error.message).toContain('"nope"');

    await writePack([...BINDINGS, binding({ id: "elsewhere", target_doc: "other.docx", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "cell", sheet: "Fin", ref: "A1" } })]);
    const refused = await tool<Refreshed>("pack_link_refresh", { pack: "quarterly", mode: "commit" });
    expect(refused.result.structuredContent).toMatchObject({ updated: 0, failed: 1 });
    expect(refused.result.structuredContent.bindings.map((b) => [b.binding, b.status])).toEqual([
      ["docx-table", "unchanged"],
      ["docx-headline", "unchanged"],
      ["pptx-table", "unchanged"],
      ["elsewhere", "failed"],
    ]);
    expect(refused.result.structuredContent.bindings[3]?.message).toContain("target-missing");
    expect((await headOf("deck.docx")).head.revision).toBe(0);
    expect((await headOf("deck.pptx")).head.revision).toBe(0);
  });
});
