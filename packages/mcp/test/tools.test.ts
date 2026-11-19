// The eight tools, one session at a time: what each returns, what each refuses, and what each leaves in the room.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { validateSchema } from "@wolfsdk/protocol/session";
import { MCP_WORKSPACE_SCHEMA, type PackManifest, validatePackManifest } from "@wolfsdk/protocol/workspace";
import { type DocumentEngine, EngineRefusal, RoomServer } from "@wolfsdk/server";
import { McpServer, blankDocument, type PackRefresher } from "../src/index.ts";
import { writeZip } from "../src/read/index.ts";
import type { McpSession } from "../src/server.ts";
import { BRIEF_LINES, alice, bob, callTool, dataOf, disposeAll, headOf, listen, makeWorkspace, must, onDispose, openSession, request, resultOf, robot, rpcErrorOf, steppingClock, toolErrorOf, type Workspace } from "./fixtures/workspace.ts";
import { MEMORY_ENTITLEMENT, MemoryEngine, wordDocument } from "./fixtures/memory-engine.ts";

setDefaultTimeout(120_000);
afterEach(disposeAll);

async function setup(): Promise<{ workspace: Workspace; session: McpSession }> {
  const workspace = await makeWorkspace();
  return { workspace, session: await openSession(workspace.mcp) };
}

describe("tool argument guidance", () => {
  test("an undefined argument is refused with the defined arguments for every tool", async () => {
    const { workspace, session } = await setup();
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["workspace_list", {}, ["format", "limit"]],
      ["doc_read", { doc: "brief.docx" }, ["doc", "view", "target", "max_nodes"]],
      ["doc_search", { query: "Revenue" }, ["query", "doc", "regex", "limit"]],
      ["doc_create", { name: "new.docx", format: "docx" }, ["name", "format", "template", "ops"]],
      ["doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "New" }] }, ["doc", "base_revision", "mode", "ops", "message"]],
      ["doc_inspect_visual", { doc: "brief.docx" }, ["doc", "pages", "dpi", "preflight", "proposal_id"]],
      ["pack_link_refresh", { pack: "review" }, ["pack", "bindings", "mode"]],
      ["comment_reply", { thread_id: "thread", body: "Reply" }, ["thread_id", "body", "resolve"]],
    ];
    for (const [name, args, defined] of cases) {
      const error = rpcErrorOf(await session.handle(request("tools/call", { name, arguments: { ...args, surprise: true } })));
      expect(error.code).toBe(-32602);
      const guidance = `$.arguments: unexpected surprise. Defined arguments for ${name}: ${defined.join(", ")}.`;
      expect(error.data).toMatchObject({ problems: [guidance] });
      expect(error.message).toContain(guidance);
    }
    // The two guessed argument names from the walkthrough, including a call also missing doc.
    for (const [name, args, defined] of [
      ["doc_read", { name: "deck.pptx" }, "doc, view, target, max_nodes"],
      ["doc_inspect_visual", { doc: "deck.pptx", target: "slide:#1" }, "doc, pages, dpi, preflight, proposal_id"],
    ] as const) {
      const unknown = name === "doc_read" ? "name" : "target";
      const error = rpcErrorOf(await session.handle(request("tools/call", { name, arguments: args })));
      expect(error.code).toBe(-32602);
      const guidance = `$.arguments: unexpected ${unknown}. Defined arguments for ${name}: ${defined}.`;
      expect(error.data).toMatchObject({ problems: expect.arrayContaining([guidance]) });
      expect(error.message).toContain(guidance);
    }
    for (const key of ["constructor", "toString", "__proto__"]) {
      const args = JSON.parse(`{"doc":"brief.docx","${key}":true}`);
      const error = rpcErrorOf(await session.handle(request("tools/call", { name: "doc_read", arguments: args })));
      expect(error.code).toBe(-32602);
      expect(error.message).toContain(`unexpected ${key}. Defined arguments for doc_read: doc, view, target, max_nodes.`);
    }
    expect(must(await workspace.room.getRoom("room", alice)).proposals).toEqual([]);
    expect((await headOf(workspace, "brief.docx")).revision).toBe(0);
  });

  test("tools/list describes a supported text change for each editable format", async () => {
    const { session } = await setup();
    const { tools } = resultOf(await session.handle(request("tools/list"))) as { tools: { name: string; description: string }[] };
    const description = tools.find((tool) => tool.name === "doc_edit")?.description ?? "";
    expect(description).toMatch(/DOCX:.*?replace-text.*?set.*?value\.text/);
    expect(description).toMatch(/PPTX:.*?replace-text.*?set.*?value\.text/);
    expect(description).toMatch(/XLSX:.*?set.*?value\.string/);
    expect(description).toContain("PDF is read-only");
  });
});

describe("workspace_list", () => {
  test("lists the documents with their heads and what is open on them", async () => {
    const { workspace, session } = await setup();
    const brief = must(await workspace.room.readHead("room", alice, "brief.docx")).head;
    must(
      await workspace.room.postComment("room", alice, { thread_id: null, doc_name: "brief.docx", target_address: "para:@2", body: "Source?", mentions: [] }),
    );
    const proposed = await callTool(session, "doc_edit", {
      doc: "brief.docx",
      base_revision: 0,
      mode: "propose",
      ops: [{ op: "append_paragraph", text: "Open item" }],
    });
    const data = dataOf(await callTool(session, "workspace_list"));
    expect(data.room_id).toBe("room");
    expect(data.total_documents).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.documents).toEqual([
      { name: "brief.docx", format: "docx", revision: 0, sha256: brief.sha256, updated_at: brief.updated_at, open_proposals: 1, open_threads: 1 },
      expect.objectContaining({ name: "model.xlsx", format: "xlsx", revision: 0, open_proposals: 0, open_threads: 0 }),
    ]);
    expect(data.proposals).toEqual([
      expect.objectContaining({ proposal_id: dataOf(proposed).proposal_id, doc_name: "brief.docx", base_revision: 0, author: "robot", ops: 1 }),
    ]);
    expect(data.packs).toEqual([]);
    expect(data.seq).toBeGreaterThan(0);
  });

  test("shows each open thread with what was said, so the agent can answer it by id", async () => {
    const { workspace, session } = await setup();
    must(
      await workspace.room.postComment("room", alice, { thread_id: null, doc_name: "brief.docx", target_address: "para:@2", body: "Source?", mentions: [] }),
    );
    const [thread] = dataOf(await callTool(session, "workspace_list")).threads as { thread_id: string; messages: { author: string; body: string }[] }[];
    expect(thread).toMatchObject({ doc_name: "brief.docx", target_address: "para:@2", mentions: [] });
    expect(thread?.messages.map(({ author, body }) => ({ author, body }))).toEqual([{ author: alice.id, body: "Source?" }]);
    const reply = await callTool(session, "comment_reply", { thread_id: thread?.thread_id, body: "The Q3 ledger.", resolve: true });
    expect(reply.isError).toBeFalsy();
    expect(dataOf(await callTool(session, "workspace_list")).threads).toEqual([]);
  });

  test("filters by format and cuts at the limit", async () => {
    const { session } = await setup();
    const sheets = dataOf(await callTool(session, "workspace_list", { format: "xlsx" }));
    expect((sheets.documents as { name: string }[]).map((d) => d.name)).toEqual(["model.xlsx"]);
    const cut = dataOf(await callTool(session, "workspace_list", { limit: 1 }));
    expect(cut.documents).toHaveLength(1);
    expect(cut.total_documents).toBe(2);
    expect(cut.truncated).toBe(true);
  });

  test("a result is one JSON text block that equals its structured content", async () => {
    const { session } = await setup();
    const result = await callTool(session, "workspace_list");
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    expect(block?.type).toBe("text");
    expect(JSON.parse((block as { text: string }).text)).toEqual(result.structuredContent);
    expect(result.isError).toBeUndefined();
  });

  describe("pack bindings, from the pack manifests", () => {
    const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const relsOf = (id: string, type: string, target: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL}"><Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/></Relationships>`;
    const types = (part: string, type: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="${part}" ContentType="${type}"/></Types>`;
    const text = (ref: string, value: string): string => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;

    /** fin.xlsx: sheet Fin with the headline revenue in B2 (a formula and its cached value), the workbook-scoped
     * defined name Headline pointing at it, and a region table in A4:B6. */
    function finWorkbook(): Uint8Array {
      const sheet =
        `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>` +
        `<row r="1">${text("A1", "Metric")}</row>` +
        `<row r="2">${text("A2", "Revenue")}<c r="B2"><f>SUM(B5:B6)</f><v>1250000</v></c></row>` +
        `<row r="4">${text("A4", "Region")}${text("B4", "Revenue")}</row>` +
        `<row r="5">${text("A5", "West")}<c r="B5"><v>500000</v></c></row>` +
        `<row r="6">${text("A6", "East")}<c r="B6"><v>750000</v></c></row>` +
        `</sheetData></worksheet>`;
      return writeZip([
        { name: "[Content_Types].xml", data: types("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") },
        { name: "_rels/.rels", data: relsOf("rId1", "officeDocument", "xl/workbook.xml") },
        {
          name: "xl/workbook.xml",
          data:
            `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Fin" sheetId="1" r:id="rId1"/></sheets>` +
            `<definedNames><definedName name="Headline">Fin!$B$2</definedName></definedNames></workbook>`,
        },
        { name: "xl/_rels/workbook.xml.rels", data: relsOf("rId1", "worksheet", "worksheets/sheet1.xml") },
        { name: "xl/worksheets/sheet1.xml", data: sheet },
      ]);
    }

    /** memo.docx: one paragraph inside the bookmark Headline. */
    function memoDocument(): Uint8Array {
      const body = `<w:p><w:bookmarkStart w:id="0" w:name="Headline"/><w:r><w:t>Revenue was 1.1m</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`;
      return writeZip([
        { name: "[Content_Types].xml", data: types("/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") },
        { name: "_rels/.rels", data: relsOf("rId1", "officeDocument", "word/document.xml") },
        { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>` },
      ]);
    }

    const determinism = { clock: "2026-11-13T00:00:00Z", seed: 7 };
    const MANIFEST: PackManifest = {
      contract: "wolfsdk.pack.v1",
      pack_id: "board",
      name: "Board pack",
      sources: [
        { id: "fin", kind: "xlsx", doc_name: "fin.xlsx", determinism },
        { id: "plan", kind: "xlsx", doc_name: "plan.xlsx", determinism },
      ],
      bindings: [
        {
          id: "headline",
          source_id: "fin",
          selector: { type: "defined_name", name: "Headline" },
          target_doc: "memo.docx",
          target_format: "docx",
          target_kind: "docx_bookmark",
          target_address: "Headline",
          number_format: null,
          fit_policy: "none",
        },
        {
          id: "regions",
          source_id: "fin",
          selector: { type: "range", sheet: "Fin", ref: "$A$4:$B$6" },
          target_doc: "memo.docx",
          target_format: "docx",
          target_kind: "docx_table",
          target_address: "table:@1",
          number_format: null,
          fit_policy: "grow",
        },
        {
          id: "plan",
          source_id: "plan",
          selector: { type: "cell", sheet: "Plan", ref: "C3" },
          target_doc: "memo.docx",
          target_format: "docx",
          target_kind: "docx_bookmark",
          target_address: "Plan",
          number_format: "0.0%",
          fit_policy: "none",
        },
      ],
    };

    async function boardSetup(): Promise<McpSession> {
      expect(validatePackManifest(MANIFEST)).toEqual([]);
      const workspace = await makeWorkspace({ packManifests: async () => [MANIFEST] });
      must(await workspace.room.addDocument("room", alice, { name: "fin.xlsx", format: "xlsx", bytes: finWorkbook() }));
      must(await workspace.room.addDocument("room", alice, { name: "memo.docx", format: "docx", bytes: memoDocument() }));
      return openSession(workspace.mcp);
    }

    test("each binding shows its kind, the cell a defined name resolves to, the value there and its docx target", async () => {
      const session = await boardSetup();
      const [pack, ...others] = dataOf(await callTool(session, "workspace_list")).packs as Record<string, unknown>[];
      expect(others).toEqual([]);
      expect(pack).toEqual({
        pack: "board",
        bindings: ["headline", "regions", "plan"],
        title: "Board pack",
        definitions: [
          {
            id: "headline",
            kind: "docx_bookmark",
            selector: { type: "defined_name", name: "Headline" },
            source_doc: "fin.xlsx",
            source_address: "sheet:Fin/cell:B2",
            source_revision: 0,
            value: 1250000,
            target_doc: "memo.docx",
            target_address: "bookmark:Headline",
          },
          {
            id: "regions",
            kind: "docx_table",
            selector: { type: "range", sheet: "Fin", ref: "$A$4:$B$6" },
            source_doc: "fin.xlsx",
            source_address: "sheet:Fin/range:A4:B6",
            source_revision: 0,
            value: [
              ["Region", "Revenue"],
              ["West", 500000],
              ["East", 750000],
            ],
            target_doc: "memo.docx",
            target_address: "table:@1",
          },
          {
            id: "plan",
            kind: "docx_bookmark",
            selector: { type: "cell", sheet: "Plan", ref: "C3" },
            source_doc: "plan.xlsx",
            source_address: "sheet:Plan/cell:C3",
            target_doc: "memo.docx",
            target_address: "bookmark:Plan",
            problem: 'the room holds no document "plan.xlsx"',
          },
        ],
      });
      // The members are the ones the schema documents, and nothing else.
      expect(validateSchema({ $defs: MCP_WORKSPACE_SCHEMA.$defs, $ref: "#/$defs/workspace_list_pack" }, pack)).toEqual([]);
    });

    test("the source and target addresses are ones doc_read reads", async () => {
      const session = await boardSetup();
      const [pack] = dataOf(await callTool(session, "workspace_list")).packs as { definitions: { source_doc: string; source_address: string; target_doc: string; target_address: string }[] }[];
      const headline = pack?.definitions[0];
      const cells = dataOf(await callTool(session, "doc_read", { doc: headline?.source_doc, view: "cells", target: headline?.source_address }));
      expect(cells.cells).toEqual([{ address: "sheet:#1/cell:B2", value: 1250000, formula: "=SUM(B5:B6)" }]);
      const target = dataOf(await callTool(session, "doc_read", { doc: headline?.target_doc, target: headline?.target_address }));
      expect(target.nodes).toContainEqual(expect.objectContaining({ address: "bookmark:Headline", kind: "bookmark", text: "Revenue was 1.1m" }));
    });
  });
});

describe("doc_read", () => {
  test("reads the structure with addresses, kinds and text previews", async () => {
    const { session } = await setup();
    const data = dataOf(await callTool(session, "doc_read", { doc: "brief.docx" }));
    expect(data).toMatchObject({ doc: "brief.docx", format: "docx", revision: 0, view: "structure", truncated: false });
    const nodes = data.nodes as { address: string; kind: string; text?: string }[];
    expect(nodes.map((n) => n.text)).toEqual([...BRIEF_LINES]);
    expect(nodes.every((n) => n.address.startsWith("para:"))).toBe(true);
    expect(data.total).toBe(BRIEF_LINES.length);
  });

  test("reads text and markdown, whole or at an address", async () => {
    const { session } = await setup();
    const text = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" }));
    expect(text.text).toBe(BRIEF_LINES.join("\n"));
    const markdown = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "markdown" }));
    expect(String(markdown.markdown)).toContain("Revenue grew in Q3.");
    const one = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", target: "para:@3" }));
    expect(one).toMatchObject({ target: "para:@3", text: "Costs are flat." });
  });

  test("cuts a long answer to max_nodes and says so", async () => {
    const { session } = await setup();
    const cut = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", max_nodes: 2 }));
    expect(cut.nodes).toHaveLength(2);
    expect(cut.total).toBe(BRIEF_LINES.length);
    expect(cut.truncated).toBe(true);
    const lines = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", max_nodes: 2 }));
    expect(lines.text).toBe(`${BRIEF_LINES[0]}\n${BRIEF_LINES[1]}`);
    expect(lines.truncated).toBe(true);
  });

  test("reads the cells of a workbook, and refuses the cells of a document", async () => {
    const { workspace, session } = await setup();
    const sheet = dataOf(await callTool(session, "doc_read", { doc: "model.xlsx", view: "cells" }));
    expect(sheet.view).toBe("cells");
    expect(Array.isArray(sheet.cells)).toBe(true);
    const error = toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "cells" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toEqual({ reason: "unsupported-view" });
    expect(workspace.engine.replays.length).toBeGreaterThan(0);
  });

  test("refuses an unknown document and an address that names nothing", async () => {
    const { session } = await setup();
    expect(toolErrorOf(await callTool(session, "doc_read", { doc: "missing.docx" })).code).toBe("UNKNOWN_DOCUMENT");
    const error = toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx", target: "para:@99" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toEqual({ reason: "address-unresolved" });
  });

  test("a document the reader can not open is a BAD_REQUEST, not a crash", async () => {
    const { workspace, session } = await setup();
    must(await workspace.room.addDocument("room", alice, { name: "broken.docx", format: "docx", bytes: new TextEncoder().encode("not a package") }));
    const error = toolErrorOf(await callTool(session, "doc_read", { doc: "broken.docx" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toEqual({ reason: "invalid-input" });
  });
});

describe("doc_search", () => {
  test("finds a literal ignoring case, with an address that doc_read accepts", async () => {
    const { session } = await setup();
    const data = dataOf(await callTool(session, "doc_search", { query: "REVENUE" }));
    const hits = data.hits as { doc: string; address: string; snippet: string; revision: number }[];
    expect(hits).toEqual([{ doc: "brief.docx", address: "para:@2", snippet: "Revenue grew in Q3.", revision: 0 }]);
    expect(data).toMatchObject({ regex: false, truncated: false, searched: 2 });
    const read = dataOf(await callTool(session, "doc_read", { doc: hits[0]?.doc, view: "text", target: hits[0]?.address }));
    expect(read.text).toBe("Revenue grew in Q3.");
  });

  test("a literal is not a pattern", async () => {
    const { session } = await setup();
    expect(dataOf(await callTool(session, "doc_search", { query: "Q[0-9]" })).hits).toEqual([]);
    const hits = dataOf(await callTool(session, "doc_search", { query: "Q[0-9]", regex: true })).hits as { address: string }[];
    expect(hits.map((h) => h.address)).toEqual(["para:@2"]);
  });

  test("stops at the limit and says there was more", async () => {
    const { session } = await setup();
    const data = dataOf(await callTool(session, "doc_search", { query: "e", limit: 1 }));
    expect(data.hits).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });

  test("searches one document when asked, and skips an unreadable one when it searches them all", async () => {
    const { workspace, session } = await setup();
    must(await workspace.room.addDocument("room", alice, { name: "broken.docx", format: "docx", bytes: new TextEncoder().encode("not a package") }));
    const all = dataOf(await callTool(session, "doc_search", { query: "costs" }));
    expect(all.skipped).toEqual([expect.objectContaining({ doc: "broken.docx" })]);
    expect(all.searched).toBe(2);
    expect((all.hits as unknown[]).length).toBe(1);
    expect(toolErrorOf(await callTool(session, "doc_search", { query: "costs", doc: "broken.docx" })).code).toBe("BAD_REQUEST");
    expect(toolErrorOf(await callTool(session, "doc_search", { query: "costs", doc: "missing.docx" })).code).toBe("UNKNOWN_DOCUMENT");
  });

  test("terminates a catastrophic backtracking regex without stalling concurrent room calls", async () => {
    const { session } = await setup();
    const started = performance.now();
    const [searchRes, listRes] = await Promise.all([
      callTool(session, "doc_search", { query: "(.*.*)*!", regex: true }),
      callTool(session, "workspace_list"),
    ]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(dataOf(listRes).total_documents).toBe(2);
    const err = toolErrorOf(searchRes);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.detail).toEqual({ reason: "regex-timeout" });
  });
});

describe("doc_create", () => {
  test("creates a blank document that can be read at once", async () => {
    const { session } = await setup();
    const created = dataOf(await callTool(session, "doc_create", { name: "plan.docx", format: "docx" }));
    expect(created).toMatchObject({ doc: "plan.docx", format: "docx", revision: 0 });
    expect(dataOf(await callTool(session, "workspace_list")).total_documents).toBe(3);
    expect(dataOf(await callTool(session, "doc_read", { doc: "plan.docx", view: "text" })).revision).toBe(0);
  });

  test("creates the other formats too", async () => {
    const { session } = await setup();
    for (const [name, format] of [["data.xlsx", "xlsx"], ["deck.pptx", "pptx"]] as const) {
      // A format the engine does not hold is still a document the room can keep; the room asks the engine to open it.
      const result = await callTool(session, "doc_create", { name, format });
      expect(dataOf(result)).toMatchObject({ doc: name, format, revision: 0 });
    }
  });

  test("applies the first ops as a commit and reports its entry", async () => {
    const { workspace, session } = await setup();
    const created = dataOf(
      await callTool(session, "doc_create", { name: "plan.docx", format: "docx", ops: [{ op: "append_paragraph", text: "Goals" }] }),
    );
    expect(created).toMatchObject({ doc: "plan.docx", revision: 1 });
    expect(typeof created.entry_id).toBe("number");
    const entry = must(await workspace.room.getRoom("room", alice)).session_log.find((e) => e.seq === created.entry_id);
    expect(entry).toMatchObject({ doc_name: "plan.docx", revision: 1, author: robot });
    expect(dataOf(await callTool(session, "doc_read", { doc: "plan.docx", view: "text" })).text).toBe("Goals");
  });

  test("copies a template", async () => {
    const { workspace, session } = await setup();
    const created = dataOf(await callTool(session, "doc_create", { name: "copy.docx", format: "docx", template: "brief.docx" }));
    expect(created).toMatchObject({ doc: "copy.docx", template: "brief.docx", revision: 0, sha256: (await headOf(workspace, "brief.docx")).sha256 });
    expect(toolErrorOf(await callTool(session, "doc_create", { name: "x.docx", format: "docx", template: "model.xlsx" })).detail).toEqual({ reason: "template-format" });
    expect(toolErrorOf(await callTool(session, "doc_create", { name: "x.docx", format: "docx", template: "nope.docx" })).code).toBe("UNKNOWN_DOCUMENT");
  });

  test("refuses a name that does not end in the format, and a name that is taken", async () => {
    const { session } = await setup();
    const wrong = toolErrorOf(await callTool(session, "doc_create", { name: "plan.xlsx", format: "docx" }));
    expect(wrong).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "name-extension" } });
    expect(toolErrorOf(await callTool(session, "doc_create", { name: "brief.docx", format: "docx" })).code).toBe("BAD_REQUEST");
  });

  test("when the ops are refused the document exists, and the error says so", async () => {
    const { workspace, session } = await setup();
    const error = toolErrorOf(await callTool(session, "doc_create", { name: "plan.docx", format: "docx", ops: [{ op: "no_such_op" }] }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toMatchObject({ created: { doc: "plan.docx", revision: 0 } });
    expect(must(await workspace.room.readHead("room", alice, "plan.docx")).head.revision).toBe(0);
  });
});

describe("doc_edit", () => {
  test("commit applies the ops at once and reports the new head and the log entry", async () => {
    const { workspace, session } = await setup();
    const before = await headOf(workspace, "brief.docx");
    const data = dataOf(
      await callTool(session, "doc_edit", {
        doc: "brief.docx",
        base_revision: 0,
        mode: "commit",
        ops: [{ op: "replace_text", find: "flat", text: "down 2%" }],
        message: "fix the cost line",
      }),
    );
    expect(data).toMatchObject({ mode: "commit", doc: "brief.docx", revision: 1, base_sha256: before.sha256 });
    expect(data.sha256).not.toBe(before.sha256);
    expect(await headOf(workspace, "brief.docx")).toEqual({ revision: 1, sha256: data.sha256 as string });
    const entry = must(await workspace.room.getRoom("room", alice)).session_log.find((e) => e.seq === data.entry_id);
    expect(entry).toMatchObject({ author: robot, base_sha256: before.sha256, result_sha256: data.sha256, proposal_id: null, batch: { label: "fix the cost line" } });
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", target: "para:@3" })).text).toBe("Costs are down 2%.");
  });

  test("propose holds the ops for a person and changes nothing", async () => {
    const { workspace, session } = await setup();
    const before = await headOf(workspace, "brief.docx");
    const data = dataOf(
      await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "Decision" }] }),
    );
    expect(data).toMatchObject({ mode: "propose", status: "open", doc: "brief.docx", base_revision: 0, ops: 1 });
    expect(data.preview_sha256).not.toBe(before.sha256);
    expect(typeof data.proposal_id).toBe("string");
    expect(await headOf(workspace, "brief.docx")).toEqual(before);
    const proposal = must(await workspace.room.getRoom("room", alice)).proposals[0];
    expect(proposal).toMatchObject({ proposal_id: data.proposal_id, author: robot, status: "open" });
  });

  test("a repeated propose answers with the proposal already open, says existed, and opens nothing", async () => {
    const { workspace, session } = await setup();
    const edit = { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "Decision" }] };
    const first = dataOf(await callTool(session, "doc_edit", { ...edit, message: "add the decision" }));
    expect(first).toMatchObject({ mode: "propose", status: "open", existed: false });
    const events = await listen(workspace);
    const again = dataOf(await callTool(session, "doc_edit", { ...edit, message: "add the decision again" }));
    expect(again).toEqual({ ...first, existed: true });
    expect(events.filter((event) => event.type === "proposal.updated")).toEqual([]);
    expect(must(await workspace.room.getRoom("room", alice)).proposals.map((proposal): unknown => proposal.proposal_id)).toEqual([first.proposal_id]);
    // Other ops are new work: a proposal of its own.
    const other = dataOf(await callTool(session, "doc_edit", { ...edit, ops: [{ op: "append_paragraph", text: "Owner" }] }));
    expect(other).toMatchObject({ existed: false });
    expect(other.proposal_id).not.toBe(first.proposal_id);
  });

  test("a person approving the proposal commits it, and the agent then reads the result", async () => {
    const { workspace, session } = await setup();
    const proposed = dataOf(
      await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "Decision" }] }),
    );
    const decided = must(await workspace.room.decideProposal("room", alice, { proposal_id: proposed.proposal_id as string, decision: "approve" }));
    expect(decided.head.revision).toBe(1);
    expect(decided.head.sha256).toBe(proposed.preview_sha256 as string);
    const read = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" }));
    expect(read).toMatchObject({ revision: 1, sha256: proposed.preview_sha256 });
    expect(String(read.text).endsWith("Decision")).toBe(true);
  });

  test("a stale base_revision is REVISION_MISMATCH carrying the head to rebase on", async () => {
    const { session } = await setup();
    const op = [{ op: "append_paragraph", text: "More" }];
    expect(dataOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: op })).revision).toBe(1);
    const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: op }));
    expect(error.code).toBe("REVISION_MISMATCH");
    expect(error.detail).toMatchObject({ doc_name: "brief.docx", base_revision: 0, head: { revision: 1 } });
  });

  test("an op the engine refuses commits nothing and says why", async () => {
    const { workspace, session } = await setup();
    const before = await headOf(workspace, "brief.docx");
    for (const mode of ["commit", "propose"] as const) {
      const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode, ops: [{ op: "replace_text", find: "absent", text: "x" }] }));
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toContain("text-not-found");
    }
    expect(await headOf(workspace, "brief.docx")).toEqual(before);
    expect(must(await workspace.room.getRoom("room", alice)).proposals).toEqual([]);
  });

  test("an op name the engine does not know is answered with the ops of the format and the members of each", async () => {
    const { workspace, session } = await setup();
    // What the engine answers for an op name it does not know: it names no op.
    workspace.engine.replay = async () => {
      throw new EngineRefusal("usage", "options.ops[].op is not a supported Agent API operation", "apply");
    };
    for (const guess of ["replace_text", "text.replace", "replaceText", "text_replace"]) {
      const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: guess, target: "para:@1", find: "a", replace: "b" }] }));
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toContain(`${JSON.stringify(guess)} (did you mean replace-text?) is not an op of docx`);
      expect(error.message).toContain("The ops of docx are replace-text, set, splice-text, insert, delete");
      expect(error.message).toContain("detail.ops of this answer gives the members of each");
      expect(error.detail).toMatchObject({ reason: "unknown-op", format: "docx", unknown_ops: [guess], did_you_mean: { [guess]: "replace-text" } });
      expect((error.detail?.ops as Record<string, string>)["replace-text"]).toStartWith("{target, find, replace}");
    }
    const sheet = toolErrorOf(await callTool(session, "doc_edit", { doc: "model.xlsx", base_revision: 0, mode: "commit", ops: [{ op: "set_cell", target: "sheet:@1/cell:A1" }] }));
    expect(sheet.message).toContain('"set_cell" is not an op of xlsx. The ops of xlsx are set, replace-text,');
    expect(sheet.detail).toMatchObject({ reason: "unknown-op", format: "xlsx", unknown_ops: ["set_cell"] });
    expect(sheet.detail).not.toHaveProperty("did_you_mean");
    expect(Object.keys(sheet.detail?.ops as Record<string, string>)).toContain("recalculate");
    expect(must(await workspace.room.getRoom("room", alice)).proposals).toEqual([]);
  });

  test("an engine refusal of an op name by its code is answered the same way, and any other refusal as it was", async () => {
    const { session } = await setup();
    const unknown = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "x" }, { op: "insert_text", text: "y" }] }));
    expect(unknown.message).toStartWith('apply refused: unknown-op: the op "insert_text" is not known. "append_paragraph", "insert_text" are not ops of docx.');
    expect(unknown.detail).toMatchObject({ reason: "unknown-op", format: "docx", unknown_ops: ["append_paragraph", "insert_text"] });
    const absent = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "replace_text", find: "absent", text: "x" }] }));
    expect(absent.message).not.toContain("not an op of");
    expect(absent.detail).toBeUndefined();
  });

  test("an unknown document is UNKNOWN_DOCUMENT", async () => {
    const { session } = await setup();
    const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "missing.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] }));
    expect(error.code).toBe("UNKNOWN_DOCUMENT");
  });
});

describe("pack_link_refresh through the room", () => {
  /** A refresher that, like the linked pack directory, sends one propose batch per binding through the room
   * service and reports each binding it sent as updated with the proposal the room answered. `revenue` writes the
   * same paragraph on every refresh; `stamp` writes the refresh number, so every refresh is new work. */
  function roomRefresher(): PackRefresher {
    let refreshes = 0;
    return {
      async refreshPack(req) {
        refreshes += 1;
        const texts: Record<string, string> = { revenue: "Revenue: 12", stamp: `Refresh ${refreshes}` };
        const bindings = [];
        for (const binding of req.bindings ?? Object.keys(texts)) {
          const head = must(await req.roomService.readHead(req.roomId, req.actor, "brief.docx")).head;
          const batch = { ops: [{ op: "append_paragraph", text: texts[binding] }], label: `refresh ${binding}` };
          const outcome = must(await req.roomService.edit(req.roomId, req.actor, { doc_name: "brief.docx", base_revision: head.revision, mode: req.mode, batch }));
          bindings.push(
            outcome.mode === "propose"
              ? { binding, status: "updated" as const, doc: "brief.docx", proposal_id: outcome.proposal.proposal_id }
              : { binding, status: "updated" as const, doc: "brief.docx", revision: outcome.head.revision },
          );
        }
        return { pack: req.pack, mode: req.mode, bindings };
      },
    };
  }

  test("a repeated refresh does not count a binding whose proposal was already open as updated", async () => {
    const workspace = await makeWorkspace({ packs: roomRefresher() });
    const session = await openSession(workspace.mcp);
    const first = dataOf(await callTool(session, "pack_link_refresh", { pack: "kpis" }));
    expect(first).toMatchObject({ pack: "kpis", mode: "propose", updated: 2, failed: 0 });
    const opened = first.bindings as { binding: string; proposal_id: string }[];
    expect(opened.map((binding) => Object.hasOwn(binding, "existed"))).toEqual([false, false]);

    const again = dataOf(await callTool(session, "pack_link_refresh", { pack: "kpis" }));
    expect(again).toMatchObject({ updated: 1, failed: 0 });
    const [revenue, stamp] = again.bindings as Record<string, unknown>[];
    expect(revenue).toEqual({ binding: "revenue", status: "unchanged", doc: "brief.docx", proposal_id: opened[0]?.proposal_id, existed: true });
    expect(stamp).toMatchObject({ binding: "stamp", status: "updated" });
    expect(stamp?.proposal_id).not.toBe(opened[1]?.proposal_id);
    expect(Object.hasOwn(stamp ?? {}, "existed")).toBe(false);

    // The room holds the revenue proposal once.
    const open = must(await workspace.room.getRoom("room", alice)).proposals.filter((proposal) => proposal.status === "open");
    expect(open.filter((proposal) => proposal.proposal_id === opened[0]?.proposal_id)).toHaveLength(1);
    expect(open).toHaveLength(3);
  });

  test("commit mode counts every binding it wrote as updated", async () => {
    const workspace = await makeWorkspace({ packs: roomRefresher() });
    const session = await openSession(workspace.mcp);
    expect(dataOf(await callTool(session, "pack_link_refresh", { pack: "kpis", mode: "commit", bindings: ["revenue"] }))).toMatchObject({ updated: 1 });
    expect(dataOf(await callTool(session, "pack_link_refresh", { pack: "kpis", mode: "commit", bindings: ["revenue"] }))).toMatchObject({ updated: 1 });
    expect(await headOf(workspace, "brief.docx")).toMatchObject({ revision: 2 });
  });
});

describe("comment_reply", () => {
  async function thread(workspace: Workspace, body = "Can you check the Q3 figure?"): Promise<string> {
    return must(
      await workspace.room.postComment("room", alice, {
        thread_id: null,
        doc_name: "brief.docx",
        target_address: "para:@2",
        body,
        mentions: [{ kind: "agent", id: "robot" }],
      }),
    ).thread_id;
  }

  test("replies in the thread as the agent", async () => {
    const { workspace, session } = await setup();
    const id = await thread(workspace);
    const data = dataOf(await callTool(session, "comment_reply", { thread_id: id, body: "Checked: it is right." }));
    const reply = data.thread as { thread_id: string; resolved: boolean; messages: { author: unknown; body: string }[] };
    expect(reply.thread_id).toBe(id);
    expect(reply.resolved).toBe(false);
    expect(reply.messages.map((m) => m.body)).toEqual(["Can you check the Q3 figure?", "Checked: it is right."]);
    expect(reply.messages[1]?.author).toEqual(robot);
    expect(data.unresolved_mentions).toBeUndefined();
  });

  test("resolves the thread with the reply", async () => {
    const { workspace, session } = await setup();
    const id = await thread(workspace);
    const data = dataOf(await callTool(session, "comment_reply", { thread_id: id, body: "Done.", resolve: true }));
    expect((data.thread as { resolved: boolean }).resolved).toBe(true);
    expect(dataOf(await callTool(session, "workspace_list")).documents).toEqual([
      expect.objectContaining({ name: "brief.docx", open_threads: 0 }),
      expect.anything(),
    ]);
  });

  test("turns @id into a mention of an actor the room knows, and reports the ids that name nobody", async () => {
    const { workspace, session } = await setup();
    const id = await thread(workspace);
    must(await workspace.room.postComment("room", bob, { thread_id: id, doc_name: "brief.docx", target_address: "para:@2", body: "Me too", mentions: [] }));
    const data = dataOf(await callTool(session, "comment_reply", { thread_id: id, body: "@alice and @bob. Also @ghost, ok?" }));
    const mentions = (data.thread as { mentions: { kind: string; id: string }[] }).mentions;
    expect(mentions).toEqual([
      { kind: "agent", id: "robot" },
      { kind: "user", id: "alice" },
      { kind: "user", id: "bob" },
    ]);
    expect(data.unresolved_mentions).toEqual(["ghost"]);
  });

  test("an unknown thread is UNKNOWN_THREAD", async () => {
    const { session } = await setup();
    expect(toolErrorOf(await callTool(session, "comment_reply", { thread_id: "nope", body: "hi" })).code).toBe("UNKNOWN_THREAD");
  });
});

describe("hooks that are not plugged in", () => {
  test("doc_inspect_visual and pack_link_refresh say so instead of pretending", async () => {
    const { session } = await setup();
    expect(toolErrorOf(await callTool(session, "doc_inspect_visual", { doc: "brief.docx" }))).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "no-renderer" } });
    expect(toolErrorOf(await callTool(session, "pack_link_refresh", { pack: "kpis" }))).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "no-pack-refresher" } });
  });
});

describe("every tool announces itself to the room and then goes idle", () => {
  test("a call is a pair of agent.activity events around its work", async () => {
    const { workspace, session } = await setup();
    const events = await listen(workspace);
    await callTool(session, "doc_read", { doc: "brief.docx", view: "text" });
    await callTool(session, "doc_search", { query: "costs" });
    await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "x" }] });
    await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "y" }] });
    const activity = events.filter((e) => e.type === "agent.activity");
    expect(activity.map((e) => [e.activity, e.doc_name])).toEqual([
      ["reading", "brief.docx"],
      ["idle", "brief.docx"],
      ["searching", null],
      ["idle", null],
      ["proposing", "brief.docx"],
      ["idle", "brief.docx"],
      ["committing", "brief.docx"],
      ["idle", "brief.docx"],
    ]);
    expect(activity.every((e) => e.agent.id === "robot")).toBe(true);
    const seqs = events.map((e) => ("seq" in e ? e.seq : -1));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  test("a failed tool still goes idle", async () => {
    const { workspace, session } = await setup();
    const events = await listen(workspace);
    await callTool(session, "doc_read", { doc: "brief.docx", target: "para:@99" });
    expect(events.filter((e) => e.type === "agent.activity").map((e) => e.activity)).toEqual(["reading", "idle"]);
  });

  test("a refused doc_edit leaves no activity that reads as a proposal or a commit", async () => {
    const { workspace, session } = await setup();
    const events = await listen(workspace);
    for (const mode of ["propose", "commit"] as const) {
      for (const op of [{ op: "replaceText", find: "costs", replace: "x" }, { op: "replace_text", find: "absent", text: "x" }]) {
        expect(toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode, ops: [op] })).code).toBe("BAD_REQUEST");
      }
    }
    expect(events.filter((e) => e.type === "agent.activity")).toEqual([]);
    await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "x" }], message: "add x" });
    const activity = events.filter((e) => e.type === "agent.activity");
    expect(activity.map((e) => [e.activity, e.detail ?? null])).toEqual([["proposing", "add x"], ["idle", null]]);
  });
});

describe("a blank document", () => {
  test("the blank packages of the three formats are what the readers open", () => {
    for (const format of ["docx", "xlsx", "pptx"] as const) expect(blankDocument(format).length).toBeGreaterThan(100);
  });

  test("wordDocument and the memory engine agree on what a page is", async () => {
    const workspace = await makeWorkspace({ seed: false });
    const head = must(await workspace.room.addDocument("room", alice, { name: "long.docx", format: "docx", bytes: wordDocument(["a", "b", "c", "d", "e"]) }));
    expect(head.revision).toBe(0);
    expect(must(await workspace.room.readHead("room", alice, "long.docx")).page_hashes).toHaveLength(3);
  });
});

describe("a room licensed for one seat", () => {
  test("an agent without a seat is refused doc_read and workspace_list, and takes none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wolfsdk-mcp-seat-"));
    // The memory engine licenses any number of seats; this one reports a single seat, which alice holds.
    const real = new MemoryEngine();
    const engine: DocumentEngine = { entitlement: async () => ({ ...MEMORY_ENTITLEMENT, max_seats: 1 }), replay: (i) => real.replay(i), close: () => real.close() };
    let n = 0;
    const room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine, now: steppingClock(), newId: () => `id-${++n}` });
    onDispose(async () => {
      await room.close();
      await rm(dir, { recursive: true, force: true });
    });
    must(await room.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await room.addDocument("room", alice, { name: "brief.docx", format: "docx", bytes: wordDocument(["Brief"]) }));
    const session = await openSession(new McpServer({ actor: robot, roomId: "room", service: room }));
    expect(toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx" })).code).toBe("LICENSE_LIMIT");
    expect(toolErrorOf(await callTool(session, "workspace_list")).code).toBe("LICENSE_LIMIT");
    expect(room.listSeats().map((seat) => `${seat.kind}:${seat.id}`)).toEqual(["user:alice"]);
  });
});
