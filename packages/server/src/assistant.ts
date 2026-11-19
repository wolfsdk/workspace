// The assistant of a room server (`wolfsdk.assistant.v1`): takes the assistant messages of a joined connection,
// runs each ask as one task of `@wolfsdk/assistant`, and keeps what a server owes for it: the stored turns, the
// usage of a workspace in a month and the allowance of a seat.
//
// A task works in the room as an agent actor operated by the user who asked, through the tool runner the
// server was given (the handlers of the room's MCP endpoint). It never commits: the task loop turns every edit
// into a proposal, and the room lets only a user decide one. A task runs detached from the connection that
// asked, so the requests behind it are not held up, and at the limit of the allowance only the assistant
// stops: nothing here stands between a connection and the room.
//
// A user who comes back while a task of theirs runs (a reconnect, a reload) is told the task again: its
// `assistant.task.started`, every step as far as it has gone and the text so far, then its events as they come.
//
// The turns live in a SQLite file of their own, beside the room database. Every event is checked against the
// contract where it meets the socket (`assistantConnection`), as the endpoints check the events of the room.
import { Database } from "bun:sqlite";
import { runAssistantTask, type AssistantEndpoint, type AssistantToolResult } from "@wolfsdk/assistant";
import {
  ASSISTANT_ALLOWANCE_EXHAUSTED,
  assistantPeriod,
  assistantPeriodEnd,
  summarizeAssistantUsage,
  validateAssistantClientMessage,
  validateAssistantEvent,
  type AssistantAgent,
  type AssistantAllowance,
  type AssistantClientMessage,
  type AssistantErrorCode,
  type AssistantServerEvent,
  type AssistantStep,
  type AssistantTurn,
  type AssistantUsageSummary,
  type AssistantUser,
  type McpWorkspaceCall,
  type RoomActor,
} from "@wolfsdk/protocol/workspace";
import { sha256Hex } from "./hash.ts";

/** The schema version of the assistant database this server reads and writes. */
export const ASSISTANT_SCHEMA_VERSION = "1";

/** The earlier turns of a conversation a task is given as context: the latest ones. */
export const ASSISTANT_HISTORY_TURNS = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  period TEXT NOT NULL,
  started_at TEXT NOT NULL,
  turn TEXT
);
CREATE INDEX IF NOT EXISTS tasks_by_seat ON tasks (user_id, period);
CREATE INDEX IF NOT EXISTS tasks_by_workspace ON tasks (workspace_id, period);
CREATE INDEX IF NOT EXISTS tasks_by_conversation ON tasks (room_id, user_id, conversation_id);
`;

/** A task from its first model call on: what the allowance counts. */
export type AssistantTaskStart = {
  task_id: string;
  workspace_id: string;
  room_id: string;
  user_id: string;
  conversation_id: string;
  started_at: string;
};

/** SQLite persistence of the assistant: one row per task from its first model call, with its turn once it has
 * finished. A task that never finished (the server stopped under it) stays counted and has no turn. */
export class AssistantStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true, strict: true });
    // As the room database: a commit that returned survives power loss, and another connection that holds the
    // write lock for a moment is waited for.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA);
    const version = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("schema_version");
    if (version === null) {
      this.db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(ASSISTANT_SCHEMA_VERSION);
    } else if (version.value !== ASSISTANT_SCHEMA_VERSION) {
      throw new Error(`assistant database has schema version ${version.value}; this server reads ${ASSISTANT_SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Count a task: called at its first model call. */
  start(task: AssistantTaskStart): void {
    this.db
      .query("INSERT INTO tasks (task_id, workspace_id, room_id, user_id, conversation_id, period, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(task.task_id, task.workspace_id, task.room_id, task.user_id, task.conversation_id, assistantPeriod(task.started_at), task.started_at);
  }

  /** Store the turn of a counted task. */
  finish(turn: AssistantTurn): void {
    const stored = this.db.query("UPDATE tasks SET turn = ? WHERE task_id = ?").run(JSON.stringify(turn), turn.task_id);
    if (stored.changes !== 1) throw new Error(`assistant task ${turn.task_id} finished but was never counted`);
  }

  /** The tasks a seat has started in a month. */
  count(userId: string, period: string): number {
    const row = this.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND period = ?").get(userId, period);
    return row?.n ?? 0;
  }

  /** Whether a user has a conversation of this id in a room. */
  hasConversation(roomId: string, userId: string, conversationId: string): boolean {
    return (
      this.db
        .query<{ one: number }, [string, string, string]>("SELECT 1 AS one FROM tasks WHERE room_id = ? AND user_id = ? AND conversation_id = ? LIMIT 1")
        .get(roomId, userId, conversationId) !== null
    );
  }

  /** The conversation of the latest task of a user in a room. */
  latestConversation(roomId: string, userId: string): string | null {
    const row = this.db
      .query<{ conversation_id: string }, [string, string]>("SELECT conversation_id FROM tasks WHERE room_id = ? AND user_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(roomId, userId);
    return row?.conversation_id ?? null;
  }

  /** The finished turns of a conversation, oldest first. */
  conversation(roomId: string, userId: string, conversationId: string): AssistantTurn[] {
    return this.db
      .query<{ turn: string }, [string, string, string]>(
        "SELECT turn FROM tasks WHERE room_id = ? AND user_id = ? AND conversation_id = ? AND turn IS NOT NULL ORDER BY rowid",
      )
      .all(roomId, userId, conversationId)
      .map((row) => JSON.parse(row.turn) as AssistantTurn);
  }

  /** The finished turns of a workspace that started in a month, oldest first. */
  turns(workspaceId: string, period: string): AssistantTurn[] {
    return this.db
      .query<{ turn: string }, [string, string]>("SELECT turn FROM tasks WHERE workspace_id = ? AND period = ? AND turn IS NOT NULL ORDER BY rowid")
      .all(workspaceId, period)
      .map((row) => JSON.parse(row.turn) as AssistantTurn);
  }
}

/** Runs one validated tool call in a room as the assistant's agent actor: the handlers of the room's MCP
 * endpoint. */
export type AssistantToolRunner = (roomId: string, agent: AssistantAgent, call: McpWorkspaceCall) => Promise<AssistantToolResult>;

export type AssistantServiceOptions = {
  /** The chat-completions endpoint of the model, or `null`: the assistant is not configured. */
  endpoint: AssistantEndpoint | null;
  /** The tasks a seat may start in a calendar month (UTC), or `null`: the server does not meter. */
  allowance: number | null;
  /** The SQLite file of the turns. */
  storePath: string;
  /** The rooms of the server: a task records the workspace of its room. */
  rooms: { listRooms(): Promise<{ room_id: string; workspace_id: string }[]> };
  tools: AssistantToolRunner;
  fetch?: typeof fetch;
  /** The current instant as an RFC 3339 UTC string. */
  now?: () => string;
};

/** One authenticated connection, as its endpoint sees it now. An endpoint keeps one object per socket. */
export type AssistantConnection = {
  readonly actor: RoomActor;
  /** The room the connection has joined, or `null`. */
  readonly roomId: string | null;
  /** False once the socket has closed. */
  readonly open: boolean;
  /** Validate against the contract, then send. */
  send(event: AssistantServerEvent): void;
};

/** The part of a server WebSocket the assistant needs: what both endpoints of the room keep per connection. */
export type AssistantSocket = {
  readonly data: { readonly actor: RoomActor; readonly roomId: string | null; readonly closed: boolean };
  /** The bytes sent, or 0 when the client does not read. */
  send(text: string): number;
  close(code: number, reason: string): void;
};

/** The connection of a socket. An event that does not validate is a bug of the server, not of the client: the
 * socket is closed rather than fed something the contract does not allow. A client that does not read is
 * closed too, so its backlog cannot grow without bound. */
export function assistantConnection(ws: AssistantSocket): AssistantConnection {
  return {
    get actor() {
      return ws.data.actor;
    },
    get roomId() {
      return ws.data.roomId;
    },
    get open() {
      return !ws.data.closed;
    },
    send(event) {
      if (ws.data.closed) return;
      const problems = validateAssistantEvent(event);
      if (problems.length > 0) {
        console.error(`assistant: refusing to send an invalid ${event.type}: ${problems.join("; ")}`);
        ws.close(1011, "internal error");
        return;
      }
      if (ws.send(JSON.stringify(event)) === 0) ws.close(1013, "too slow to follow");
    },
  };
}

type TaskStarted = Extract<AssistantServerEvent, { type: "assistant.task.started" }>;

type Running = {
  taskId: string;
  userId: string;
  controller: AbortController;
  /** Where the events of the task go: the connection that asked, or the one the user came back on. */
  connection: AssistantConnection;
  done: Promise<void>;
  /** The task as far as it has gone, to tell a connection that comes back while it runs: its start (null
   * until its first model call), the latest announcement of each step, and its text so far. */
  started: TaskStarted | null;
  steps: Map<number, AssistantStep>;
  text: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The agent actor the assistant acts as for a user: one per user, the same in every room, with an id no
 * longer than the contract allows whatever the id of the user. */
export function assistantAgentOf(user: { id: string; name: string }): AssistantAgent {
  return { kind: "agent", id: `assistant-${sha256Hex(new TextEncoder().encode(user.id)).slice(0, 32)}`, name: `Assistant (${user.name})` };
}

const exhausted = (allowance: AssistantAllowance): boolean => allowance.limit !== null && allowance.used >= allowance.limit;

export class AssistantService {
  readonly #endpoint: AssistantEndpoint | null;
  readonly #limit: number | null;
  readonly #store: AssistantStore;
  readonly #rooms: AssistantServiceOptions["rooms"];
  readonly #tools: AssistantToolRunner;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => string;
  /** The running task of a user in a room, by `room user`: neither id holds a space. */
  readonly #running = new Map<string, Running>();
  /** Who asked, by the id of the agent actor that works for them. */
  readonly #operators = new Map<string, { id: string; name: string }>();
  /** The workspace of a room, which never changes. */
  readonly #workspaces = new Map<string, string>();

  constructor(options: AssistantServiceOptions) {
    if (options.allowance !== null && (!Number.isInteger(options.allowance) || options.allowance < 0)) {
      throw new Error(`the assistant allowance is a whole number of tasks per seat per month, or unset: got ${options.allowance}`);
    }
    this.#endpoint = options.endpoint;
    this.#limit = options.allowance;
    this.#store = new AssistantStore(options.storePath);
    this.#rooms = options.rooms;
    this.#tools = options.tools;
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** The user an assistant agent works for: the seat its calls in a room act on. `null` for any other agent.
   * Give this to the room server as (part of) its `operatorOf`. */
  operatorOf(agent: RoomActor): { id: string; name: string } | null {
    return agent.kind === "agent" ? (this.#operators.get(agent.id) ?? null) : null;
  }

  /** The assistant usage of a workspace in a month (`2026-11`): its finished tasks and their tokens per seat. */
  usage(workspaceId: string, period: string): AssistantUsageSummary {
    return summarizeAssistantUsage(workspaceId, period, this.#store.turns(workspaceId, period));
  }

  /** Cancel every running task, wait for each to store its turn, and close the database. */
  async close(): Promise<void> {
    const running = [...this.#running.values()];
    for (const task of running) task.controller.abort();
    await Promise.all(running.map((task) => task.done));
    this.#store.close();
  }

  /** Answer one message of a connection whose `type` begins `assistant.`. Returns once the message is answered
   * or, for an ask, once its task has started: it does not wait for the task. */
  async handle(connection: AssistantConnection, message: unknown): Promise<void> {
    const refuse = (requestId: string | null, code: AssistantErrorCode, text: string): void =>
      connection.send({ type: "assistant.error", request_id: requestId, code, message: text });

    const problems = validateAssistantClientMessage(message);
    if (problems.length > 0) {
      const id = typeof message === "object" && message !== null && "request_id" in message ? message.request_id : null;
      return refuse(typeof id === "string" && ID.test(id) ? id : null, "BAD_REQUEST", problems.slice(0, 5).join("; "));
    }
    // `validateAssistantClientMessage` found no problem: the message has the shape of the contract.
    const valid = message as AssistantClientMessage;
    const requestId = valid.request_id;
    const { actor, roomId } = connection;
    if (actor.kind !== "user") return refuse(requestId, "FORBIDDEN", "the assistant works for a signed-in user, not for an agent");
    if (roomId === null) return refuse(requestId, "NOT_IN_ROOM", "join a room first: send room.join");
    const user: AssistantUser = { kind: "user", id: actor.id, name: actor.name };
    const key = `${roomId} ${user.id}`;

    // A user who comes back on another connection follows the task they left running, and is told it as far
    // as it has gone. A status asked on the connection the task follows tells it again too: the panel asks for
    // one each time the room goes live, which may be on the same socket.
    const left = this.#running.get(key);
    if (left) {
      const back = left.connection !== connection && (!left.connection.open || left.connection.roomId !== roomId);
      if (back) left.connection = connection;
      if (left.connection === connection && (back || valid.type === "assistant.status")) this.#tell(left);
    }

    switch (valid.type) {
      case "assistant.status": {
        if (this.#endpoint === null) return connection.send({ type: "assistant.status", request_id: requestId, state: "not_configured", model: null, allowance: null });
        // The month of the allowance is the month of now: a status asked after the month changed reports the
        // new month, with what the seat has used in it.
        const allowance = this.#allowance(user.id, this.#now());
        return connection.send({
          type: "assistant.status",
          request_id: requestId,
          state: exhausted(allowance) ? "allowance_exhausted" : "ready",
          model: this.#endpoint.model,
          allowance,
        });
      }

      case "assistant.history": {
        const conversationId = valid.conversation_id ?? this.#store.latestConversation(roomId, user.id);
        if (valid.conversation_id !== null && !this.#store.hasConversation(roomId, user.id, valid.conversation_id)) {
          return refuse(requestId, "UNKNOWN_CONVERSATION", `you have no conversation ${valid.conversation_id} in this room`);
        }
        const turns = conversationId === null ? [] : this.#store.conversation(roomId, user.id, conversationId);
        return connection.send({ type: "assistant.conversation", request_id: requestId, conversation_id: conversationId, turns });
      }

      case "assistant.cancel": {
        const running = this.#running.get(key);
        if (running?.taskId !== valid.task_id) return refuse(requestId, "UNKNOWN_TASK", `you have no running task ${valid.task_id} in this room`);
        // The task ends with a turn of outcome `cancelled`: that event is the answer.
        return running.controller.abort();
      }

      case "assistant.ask": {
        const endpoint = this.#endpoint;
        if (endpoint === null) return refuse(requestId, "NOT_CONFIGURED", "this server has no model endpoint for the assistant");
        const workspaceId = await this.#workspaceOf(roomId);
        if (workspaceId === null) return refuse(requestId, "NOT_IN_ROOM", `this server has no room ${roomId}`);

        // From here to the first model call nothing waits, so two asks can not both pass a check.
        if (this.#running.has(key)) return refuse(requestId, "BUSY", "the assistant is still working on your last request in this room: wait for it or cancel it");
        if (valid.conversation_id !== null && !this.#store.hasConversation(roomId, user.id, valid.conversation_id)) {
          return refuse(requestId, "UNKNOWN_CONVERSATION", `you have no conversation ${valid.conversation_id} in this room`);
        }
        const allowance = this.#allowance(user.id, this.#now());
        if (exhausted(allowance)) {
          return connection.send({
            type: "assistant.error",
            request_id: requestId,
            code: ASSISTANT_ALLOWANCE_EXHAUSTED,
            message: `your seat has used its ${allowance.limit} assistant tasks of ${allowance.period}; the assistant takes requests again at ${allowance.resets_at}. Editing, review and comments continue.`,
            allowance,
          });
        }

        const taskId = crypto.randomUUID();
        const conversationId = valid.conversation_id ?? crypto.randomUUID();
        const agent = assistantAgentOf(user);
        this.#operators.set(agent.id, { id: user.id, name: user.name });
        const running: Running = {
          taskId,
          userId: user.id,
          controller: new AbortController(),
          connection,
          done: Promise.resolve(),
          started: null,
          steps: new Map(),
          text: "",
        };
        this.#running.set(key, running);
        const ended = (): void => {
          if (this.#running.get(key) === running) this.#running.delete(key);
        };

        running.done = runAssistantTask({
          endpoint,
          task: {
            task_id: taskId,
            conversation_id: conversationId,
            room_id: roomId,
            workspace_id: workspaceId,
            user,
            assistant: agent,
            request: { text: valid.text, doc_name: valid.doc_name, target_address: valid.target_address },
          },
          history: this.#store.conversation(roomId, user.id, conversationId).slice(-ASSISTANT_HISTORY_TURNS),
          execute: (call) => this.#tools(roomId, agent, call),
          // The first model call follows at once: the task counts from here, whatever becomes of it.
          started: (startedAt) => {
            this.#store.start({ task_id: taskId, workspace_id: workspaceId, room_id: roomId, user_id: user.id, conversation_id: conversationId, started_at: startedAt });
            running.started = {
              type: "assistant.task.started",
              request_id: requestId,
              task_id: taskId,
              conversation_id: conversationId,
              allowance: this.#allowance(user.id, startedAt),
              started_at: startedAt,
            };
            running.connection.send(running.started);
          },
          emit: (event) => {
            if (event.type === "assistant.step") running.steps.set(event.step.step, event.step);
            else if (event.type === "assistant.text") running.text += event.delta;
            else if (event.type === "assistant.task.finished") {
              ended();
              this.#store.finish(event.turn);
            }
            running.connection.send(event);
          },
          signal: running.controller.signal,
          now: this.#now,
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
        }).then(
          () => undefined,
          (error: unknown) => {
            // The task loop turns what a model, an endpoint or a tool does into a turn: this is a bug or a
            // broken disk. No model call is made for a task that could not be counted.
            ended();
            console.error(`assistant: task ${taskId} failed unexpectedly`, error);
          },
        );
        return;
      }
    }
  }

  /** Tell the connection a task follows what the task has done so far, in the events it was told them with:
   * its start (with the allowance of its month as it is now), the latest announcement of each step in the
   * order of the steps, and its text so far as one delta. Nothing before its first model call. */
  #tell(running: Running): void {
    const { started, connection } = running;
    if (started === null) return;
    connection.send({ ...started, allowance: this.#allowance(running.userId, started.started_at) });
    for (const step of [...running.steps.values()].sort((a, b) => a.step - b.step)) {
      connection.send({ type: "assistant.step", task_id: running.taskId, step });
    }
    if (running.text !== "") connection.send({ type: "assistant.text", task_id: running.taskId, delta: running.text });
  }

  /** The allowance of a seat in the month of `instant`. A limit lowered under what the seat has used shows the
   * seat at the limit. */
  #allowance(userId: string, instant: string): AssistantAllowance {
    const period = assistantPeriod(instant);
    const counted = this.#store.count(userId, period);
    return { period, limit: this.#limit, used: this.#limit === null ? counted : Math.min(counted, this.#limit), resets_at: assistantPeriodEnd(period) };
  }

  async #workspaceOf(roomId: string): Promise<string | null> {
    const known = this.#workspaces.get(roomId);
    if (known !== undefined) return known;
    for (const room of await this.#rooms.listRooms()) this.#workspaces.set(room.room_id, room.workspace_id);
    return this.#workspaces.get(roomId) ?? null;
  }
}
