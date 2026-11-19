// The assistant of `serve`: one port, a real room server on a temporary directory with the in-memory engine of
// the MCP tests, and a model that answers from a script, in process. A user asks over `/ws`; the assistant
// works through the tools of the room's MCP server, and what it writes is a proposal that the user approves.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAssistantEvent, validateAssistantTurn, validateRoomEvent, type AssistantTurn, type RoomActor } from "@wolfsdk/protocol/workspace";
import { assistantAgentOf, RoomServer } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import { UsageError } from "../src/errors.ts";
import { startWorkspaceServer, tokenOf, type WorkspaceAssistantOptions, type WorkspaceServer } from "../src/http.ts";
import { ASSISTANT_KEY_VARIABLE, assistantOf } from "../src/run.ts";

// Writes are flushed to disk and sockets are opened: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

/** Stands in for the key: any text a client must never be sent. */
const KEY = "placeholder-for-the-key";
const ENDPOINT = { url: "https://model.invalid/v1/chat/completions", model: "open-model-1", key: KEY };
const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const TOKENS: Record<string, RoomActor> = { "t-alice": ALICE, "t-robot": ROBOT };

type Reply = { text?: string; tools?: { name: string; arguments: unknown }[] };
type Sent = { messages: { role: string; content: unknown }[] };

function streamed(reply: Reply, call: number): Response {
  const chunks: unknown[] = [];
  if (reply.text) chunks.push({ choices: [{ delta: { content: reply.text } }] });
  (reply.tools ?? []).forEach((tool, index) => {
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${call}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } }] });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  return new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A model that answers its calls from `script`, in the order they arrive, and keeps what it was sent. */
function model(script: Reply[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const scripted = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const call = sent.length;
    sent.push(JSON.parse(String(init?.body)) as Sent);
    const next = script[call];
    if (next === undefined) throw new Error(`the script has no answer for model call ${call + 1}`);
    return streamed(next, call);
  };
  return { fetch: scripted as typeof fetch, sent };
}

type Wire = { type: string; [member: string]: unknown };

/** A client of `/ws` that remembers every event it is sent, and what the contract of each has against it. A wait
 * that is never satisfied ends with the test runner's own timeout. */
class Socket {
  readonly events: Wire[] = [];
  readonly invalid: string[] = [];
  private arrived = Promise.withResolvers<void>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (message) => {
      expect(String(message.data)).not.toContain(KEY);
      const event = JSON.parse(String(message.data)) as Wire;
      this.invalid.push(...(event.type.startsWith("assistant.") ? validateAssistantEvent(event) : validateRoomEvent(event)));
      this.events.push(event);
      this.arrived.resolve();
      this.arrived = Promise.withResolvers<void>();
    };
  }

  static async connect(url: string, token: string): Promise<Socket> {
    const socket = new WebSocket(`${url}?token=${token}`);
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error(`could not connect with ${token}`));
    await opened.promise;
    return new Socket(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  of(type: string): Wire[] {
    return this.events.filter((event) => event.type === type);
  }

  /** The `n`th event of a type, once it has arrived. */
  async nth(type: string, n = 1): Promise<Wire> {
    while (this.of(type).length < n) await this.arrived.promise;
    return this.of(type)[n - 1] as Wire;
  }

  close(): void {
    this.socket.close();
  }
}

let dir: string;
let room: RoomServer;
let server: WorkspaceServer | null = null;
let sockets: Socket[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-workspace-assistant-"));
  // As `serve` composes it: the agent of the assistant acts on the seat of the user it works for.
  room = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new MemoryEngine(),
    operatorOf: (agent) => server?.assistant.operatorOf(agent) ?? null,
  });
});

afterEach(async () => {
  for (const socket of sockets) {
    expect(socket.invalid).toEqual([]);
    socket.close();
  }
  sockets = [];
  await server?.stop();
  server = null;
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

/** The workspace server with a room `r1` that holds `brief.docx`, and a client that has joined it. */
async function start(assistant: WorkspaceAssistantOptions | null, token = "t-alice"): Promise<Socket> {
  server = startWorkspaceServer({
    service: room,
    authenticate: (request) => {
      const bearer = tokenOf(request);
      return bearer === null ? null : (TOKENS[bearer] ?? null);
    },
    assistant,
  });
  const headers = { authorization: "Bearer t-alice" };
  const created = await fetch(`${server.url}/api/rooms`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ room_id: "r1", workspace_id: "ws" }) });
  expect(created.status).toBe(201);
  const upload = await fetch(`${server.url}/api/rooms/r1/docs?name=brief.docx`, { method: "POST", headers, body: new Uint8Array(wordDocument(["Quarterly brief", "Revenue grew in Q3."])) });
  expect(upload.status).toBe(201);
  const socket = await Socket.connect(server.wsUrl, token);
  sockets.push(socket);
  socket.send({ type: "room.join", request_id: "join", room_id: "r1", since_seq: null });
  return socket;
}

const ask = (requestId: string) => ({ type: "assistant.ask", request_id: requestId, conversation_id: null, text: "Add a closing line", doc_name: "brief.docx", target_address: null });
const APPEND = { name: "doc_edit", arguments: { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "Outlook: steady." }] } };

describe("serve: the assistant", () => {
  test("an ask runs through the tools of the room's MCP server and ends as a proposal the user approves", async () => {
    const scripted = model([{ tools: [APPEND] }, { text: "I proposed a closing line." }]);
    const store = join(dir, "assistant.sqlite");
    const a = await start({ endpoint: ENDPOINT, allowance: 1, storePath: store, fetch: scripted.fetch });
    a.send({ type: "assistant.status", request_id: "s-1" });
    expect(await a.nth("assistant.status")).toMatchObject({ request_id: "s-1", state: "ready", model: "open-model-1", allowance: { limit: 1, used: 0 } });

    a.send(ask("a-1"));
    const turn = (await a.nth("assistant.task.finished")).turn as AssistantTurn;
    expect(validateAssistantTurn(turn)).toEqual([]);
    expect(turn).toMatchObject({ outcome: "proposed", user: ALICE, workspace_id: "ws", room_id: "r1" });
    expect(turn.proposal_ids).toHaveLength(1);

    // The room announced the proposal: opened by her agent, on her seat, and the document is as it was.
    const agent = assistantAgentOf(ALICE);
    expect(await a.nth("proposal.updated")).toMatchObject({ proposal: { proposal_id: turn.proposal_ids[0], status: "open", author: agent } });
    expect(room.listSeats().map((seat) => [seat.kind, seat.id])).toEqual([["user", "alice"]]);
    expect(a.of("doc.committed")).toEqual([]);
    // The model was given the answer of the MCP tool: the proposal the room holds, not a commit.
    const answer = scripted.sent[1]?.messages.find((message) => message.role === "tool");
    expect(JSON.parse(String(answer?.content))).toMatchObject({ mode: "propose", proposal_id: turn.proposal_ids[0] });

    // The edit went through the tools of the room's MCP server: they report the agent's activity around it.
    expect(a.of("agent.activity").map((event) => [(event.agent as { id: string }).id, event.activity])).toEqual([
      [agent.id, "proposing"],
      [agent.id, "idle"],
    ]);

    // At the limit the assistant stops, and says so; she approves the proposal and edits on the same connection.
    a.send(ask("a-2"));
    expect(await a.nth("assistant.error")).toMatchObject({ request_id: "a-2", code: "ALLOWANCE_EXHAUSTED", allowance: { limit: 1, used: 1 } });
    a.send({ type: "proposal.decide", request_id: "d-1", proposal_id: turn.proposal_ids[0], decision: "approve" });
    expect(await a.nth("doc.committed")).toMatchObject({ entry: { author: agent, proposal_id: turn.proposal_ids[0] } });
    a.send({ type: "comment.post", request_id: "c-1", thread_id: null, doc_name: "brief.docx", target_address: "p[1]", body: "Approved.", mentions: [] });
    expect(await a.nth("comment.updated")).toMatchObject({ thread: { doc_name: "brief.docx" } });
    expect(a.of("error")).toEqual([]);

    // The turn is in the store of the assistant, per seat.
    expect(server?.assistant.usage("ws", turn.started_at.slice(0, 7))).toMatchObject({ tasks: 1 });
    expect(existsSync(store)).toBe(true);
  });

  test("without an endpoint the assistant says it is not configured, refuses a task, and the room works as before", async () => {
    const a = await start(null);
    a.send({ type: "assistant.status", request_id: "s-1" });
    expect(await a.nth("assistant.status")).toEqual({ type: "assistant.status", request_id: "s-1", state: "not_configured", model: null, allowance: null });
    a.send(ask("a-1"));
    expect(await a.nth("assistant.error")).toMatchObject({ request_id: "a-1", code: "NOT_CONFIGURED" });
    a.send({ type: "doc.edit", request_id: "e-1", doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "By hand." }] } });
    expect(await a.nth("doc.committed")).toMatchObject({ entry: { author: ALICE } });
    expect(a.of("error")).toEqual([]);
  });

  test("an agent is refused: the assistant works for a signed-in user", async () => {
    const r = await start({ endpoint: ENDPOINT, allowance: null, storePath: join(dir, "assistant.sqlite"), fetch: model([]).fetch }, "t-robot");
    r.send(ask("a-1"));
    expect(await r.nth("assistant.error")).toMatchObject({ request_id: "a-1", code: "FORBIDDEN" });
  });
});

describe("serve: the assistant flags", () => {
  const env = { [ASSISTANT_KEY_VARIABLE]: KEY };
  const flags = { "assistant-url": ENDPOINT.url, "assistant-model": ENDPOINT.model };

  test("no flag is no assistant; the endpoint, the key of the environment and the defaults otherwise", () => {
    expect(assistantOf({}, "/data/rooms.sqlite", env)).toBeNull();
    expect(assistantOf(flags, "/data/rooms.sqlite", env)).toEqual({ endpoint: ENDPOINT, allowance: null, storePath: "/data/rooms.assistant.sqlite" });
    expect(assistantOf({ ...flags, "assistant-allowance": "200", "assistant-db": "/var/assistant.db" }, "/data/rooms.sqlite", env)).toEqual({
      endpoint: ENDPOINT,
      allowance: 200,
      storePath: "/var/assistant.db",
    });
  });

  test("half an endpoint, a missing key, a bad URL or a bad allowance is a usage error that names the flag", () => {
    const refused = (values: Parameters<typeof assistantOf>[0], variables: Record<string, string | undefined> = env): string => {
      try {
        assistantOf(values, "/data/rooms.sqlite", variables);
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        return (e as Error).message;
      }
      throw new Error("the flags were accepted");
    };
    expect(refused({ "assistant-url": ENDPOINT.url })).toContain("--assistant-url and --assistant-model come together");
    expect(refused({ "assistant-allowance": "5" })).toContain("need --assistant-url and --assistant-model");
    expect(refused(flags, {})).toContain(ASSISTANT_KEY_VARIABLE);
    expect(refused(flags, { [ASSISTANT_KEY_VARIABLE]: "" })).toContain(ASSISTANT_KEY_VARIABLE);
    expect(refused({ ...flags, "assistant-url": "model.example/v1" })).toContain("--assistant-url must be an http or https URL");
    expect(refused({ ...flags, "assistant-allowance": "-1" })).toContain("--assistant-allowance must be a whole number");
    expect(refused({ ...flags, "assistant-allowance": "1.5" })).toContain("--assistant-allowance must be a whole number");
  });
});
