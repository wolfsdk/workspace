// The commands of `wolfsdk-workspace`: `check` and `refresh` a pack on disk, `serve` the room server, and list
// or free its `seats`.
//
// Exit codes: 0 the pack is fresh (or `refresh` made it so, or `serve` stopped on a signal, or `seats` did what
// it was asked), 1 `check` found a stale binding, 2 anything that stopped a command: usage, an unreadable or
// refused pack, an engine fault, a seat that is not held.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { engineInspector, engineRenderer } from "@wolfsdk/mcp";
import {
  checkPack,
  DirectoryStore,
  PackError,
  PoolXlsxEvaluator,
  refreshPack,
  type PackProblem,
  type PackReport,
  type RefreshReport,
} from "@wolfsdk/packs";
import type { ReactorPipeCommand, ReactorPipeRequest, ReactorPipeResponse } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type EngineWorker, isRoomDatabase, PoolEngine, RoomServer, RoomStore, WorkerPool } from "@wolfsdk/server";
import { loadActorDirectory } from "./actors.ts";
import { UsageError } from "./errors.ts";
import { type SnapshotInput, startWorkspaceServer, tokenOf } from "./http.ts";

export const EXIT_FRESH = 0;
export const EXIT_STALE = 1;
export const EXIT_ERROR = 2;

export type CliIo = { out(text: string): void; err(text: string): void };

const STDIO: CliIo = { out: (text) => console.log(text), err: (text) => console.error(text) };

const USAGE = `wolfsdk-workspace: check and refresh packs, serve the workspace, list and free its seats

  wolfsdk-workspace check   [<pack dir>] [--engine <wolf>] [--json]
  wolfsdk-workspace refresh [<pack dir>] [--engine <wolf>] [--json]
  wolfsdk-workspace serve   --db <file> --blobs <dir> --engine <wolf> --actors <file>
                            [--port <n>] [--host <name>] [--pool <n>] [--static-dir <dir>]
                            [--wasm-dir <dir>] [--pack <dir>] [--default-room <id>] [--workspace-id <id>]
  wolfsdk-workspace seats   --db <file> [--json]
  wolfsdk-workspace seats release <user|agent> <id> --db <file> [--json]

check     exit 0 when every binding of the pack is fresh, 1 when one is stale, 2 on an error.
          Writes nothing.
refresh   bring the target documents up to date, all or none; exit 0 on success, 2 on an error.
serve     one port (default 127.0.0.1:8787) for the browser workspace at /, its API at /api (rooms, documents,
          display-list snapshots for shared links, the pack), the wolfsdk.room.v1 WebSocket at /ws and the
          MCP endpoint at /mcp.
          --actors is a JSON file that maps each bearer token to the actor it stands for;
          a client sends the token as "Authorization: Bearer <token>" or as the token query parameter.
seats     list the identities that hold a seat of the licence, or free the seat of one. Both read and
          write the database of serve and work while it runs. An identity whose seat was freed is
          told so; its next request takes a seat again if one is left.

--engine <wolf>       the wolf executable; it is started as "<wolf> reactor-serve". For check and refresh
                      it is optional: it recalculates XLSX sources and applies the edits, where without
                      it the package reads cached values and applies the edits itself.
--json                print the report (or the error) as one JSON document on standard output.
--static-dir <dir>    the compiled workspace UI (default: the UI packed with this package, else
                      apps/workspace/dist of a checkout, when built).
--wasm-dir <dir>      a local engine channel (latest.txt, v<VERSION>/...) served at /wasm with CORS.
--pack <dir>          the pack /api/pack checks and /api/pack/refresh refreshes on disk, and the MCP tool
                      pack_link_refresh refreshes into the documents of a room.
--default-room <id>   the room /mcp attaches to when a request names none; created at start when absent.
--workspace-id <id>   the workspace of rooms created without one (default: that of the first room).`;

const PACK_OPTIONS = {
  engine: { type: "string" },
  json: { type: "boolean" },
} as const;

const SERVE_OPTIONS = {
  db: { type: "string" },
  blobs: { type: "string" },
  engine: { type: "string" },
  actors: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  pool: { type: "string" },
  "static-dir": { type: "string" },
  "wasm-dir": { type: "string" },
  pack: { type: "string" },
  "default-room": { type: "string" },
  "workspace-id": { type: "string" },
} as const;

const SEATS_OPTIONS = {
  db: { type: "string" },
  json: { type: "boolean" },
} as const;

/** `seats`: the roster of a room database, read and changed straight in the file. A server that has the database
 * open sees the change with its next request. */
function runSeats(args: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({ args, options: SEATS_OPTIONS, allowPositionals: true });
  if (values.db === undefined) throw new UsageError("seats needs --db");
  /** The seat to free, or `null` to list the seats. */
  let release: { kind: "user" | "agent"; id: string } | null = null;
  if (positionals.length > 0) {
    const [verb, kind, id, ...extra] = positionals;
    if (verb !== "release" || (kind !== "user" && kind !== "agent") || id === undefined || extra.length > 0) {
      throw new UsageError("seats takes nothing to list the seats, or: release <user|agent> <id>");
    }
    release = { kind, id };
  }
  // The store creates a database that is not there and adds its tables to one that has none: a mistyped path
  // must leave nothing behind and change no other file.
  if (!existsSync(values.db)) throw new Error(`no room database at ${values.db}`);
  if (!isRoomDatabase(values.db)) throw new Error(`${values.db} is not a room database`);
  const store = new RoomStore(values.db);
  try {
    if (release === null) {
      const seats = store.seats();
      const lines = seats.map((s) => `${s.kind.padEnd(5)} ${s.id}  ${s.name}  since ${s.first_seen_at}`);
      lines.push(`${seats.length} seat${seats.length === 1 ? "" : "s"} taken`);
      io.out(values.json ? JSON.stringify({ seats }, null, 2) : lines.join("\n"));
      return EXIT_FRESH;
    }
    if (!store.removeSeat(release.kind, release.id)) throw new Error(`${release.kind} ${release.id} holds no seat`);
    io.out(values.json ? JSON.stringify({ released: release }, null, 2) : `freed the seat of ${release.kind} ${release.id}`);
    return EXIT_FRESH;
  } finally {
    store.close();
  }
}

/** The compiled workspace UI: `ui/` in the npm package, `apps/workspace/dist` in a checkout. */
const BUILT_UI =
  [join(import.meta.dir, "..", "ui"), join(import.meta.dir, "..", "..", "..", "apps", "workspace", "dist")].find((dir) =>
    existsSync(join(dir, "index.html")),
  ) ?? null;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function directory(flag: string, path: string | undefined): string | null {
  if (path === undefined) return null;
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new UsageError(`${flag} ${path} is not a directory`);
  return path;
}

function id(flag: string, text: string | undefined): string | null {
  if (text === undefined) return null;
  if (!ID.test(text)) throw new UsageError(`${flag} must be letters, digits and . _ : -, up to 128`);
  return text;
}

function count(flag: string, text: string | undefined, fallback: number, least: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < least || n > 65535) throw new UsageError(`${flag} must be a whole number from ${least} to 65535`);
  return n;
}

function reportLines(report: PackReport | RefreshReport, command: "check" | "refresh"): string[] {
  const lines = report.bindings.map((b) => `${b.status.padEnd(9)} ${b.binding_id}  ${b.target_doc} ${b.target_address}  ${b.ops} op${b.ops === 1 ? "" : "s"}`);
  for (const b of report.bindings) for (const note of b.notes) lines.push(`          ${b.binding_id}: ${note}`);
  const documents = report.documents.length;
  if (command === "check") {
    lines.push(report.fresh ? `pack ${report.pack_id}: fresh` : `pack ${report.pack_id}: stale, ${documents} document${documents === 1 ? "" : "s"} would change`);
  } else {
    lines.push(documents === 0 ? `pack ${report.pack_id}: already fresh` : `pack ${report.pack_id}: refreshed ${documents} document${documents === 1 ? "" : "s"}`);
  }
  return lines;
}

/** What a failure of `check` or `refresh` says: a code, a message, and the problems of a refusal. */
function failure(e: unknown): { code: string; message: string; problems: readonly PackProblem[] } {
  if (e instanceof PackError) return { code: e.code, message: e.message, problems: e.problems };
  if (e instanceof EngineFault || e instanceof EngineRefusal) return { code: "engine-failed", message: e.message, problems: [] };
  throw e;
}

async function runPack(command: "check" | "refresh", args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: PACK_OPTIONS, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError(`${command} takes one pack directory, not ${positionals.length}`);
  const pool = values.engine === undefined ? null : new WorkerPool({ command: [values.engine, "reactor-serve"] });
  try {
    const store = new DirectoryStore(positionals[0] ?? ".");
    const evaluator = pool === null ? undefined : new PoolXlsxEvaluator(pool);
    const report =
      command === "check"
        ? await checkPack(store, { evaluator })
        : await refreshPack(store, { evaluator, engine: pool === null ? undefined : new PoolEngine(pool) });
    io.out(values.json ? JSON.stringify(report, null, 2) : reportLines(report, command).join("\n"));
    return report.fresh ? EXIT_FRESH : EXIT_STALE;
  } catch (e) {
    const { code, message, problems } = failure(e);
    if (values.json) {
      io.out(JSON.stringify({ error: { code, message, problems } }, null, 2));
    } else {
      io.err(`error: ${code}: ${message}`);
      if (problems.length > 1) for (const p of problems) io.err(`  ${p.binding_id ?? "-"}  ${p.code}: ${p.message}`);
    }
    return EXIT_ERROR;
  } finally {
    await pool?.close();
  }
}

type Answer<C extends ReactorPipeCommand> = Extract<ReactorPipeResponse, { cmd: C }>;

/** The answer to `request`, narrowed to its command. `EngineRefusal` when the worker said no, `EngineFault` when it
 * answered another command. */
async function ask<C extends ReactorPipeCommand>(worker: EngineWorker, request: ReactorPipeRequest & { cmd: C }, segments: readonly Uint8Array[] = []): Promise<Answer<C>> {
  const { body } = await worker.call(request, segments);
  if ("error" in body && body.error !== undefined) throw new EngineRefusal(body.error.code, body.error.message, body.cmd ?? request.cmd, body.error.argument);
  if (body.cmd !== request.cmd) throw new EngineFault(`worker answered ${String(body.cmd)} to ${request.cmd}`);
  return body as Answer<C>;
}

/** The snapshot a shared link paints: the `display_list` answer of every page of a document, in page order. One
 * worker opens the head bytes, lays them out, asks each page and closes the document; a worker that cannot say it
 * closed the document is not reused. */
export function engineSnapshot(pool: Pick<WorkerPool, "withWorker">): (input: SnapshotInput) => Promise<unknown[]> {
  return (input) =>
    pool.withWorker(async (worker) => {
      const { doc } = await ask(worker, { cmd: "open", bytes: { bin: 0, len: input.bytes.length }, name: input.name, format: input.format }, [input.bytes]);
      try {
        const { summary } = await ask(worker, { cmd: "layout", doc });
        const pages: unknown[] = [];
        for (let page = 1; page <= summary.pages; page++) pages.push(await ask(worker, { cmd: "display_list", doc, page }));
        return pages;
      } finally {
        try {
          const { body } = await worker.call({ cmd: "close", doc });
          if (!body.ok || "error" in body) worker.discard();
        } catch {
          worker.discard();
        }
      }
    });
}

async function runServe(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: SERVE_OPTIONS, allowPositionals: false });
  const { db, blobs, engine, actors: actorsFile } = values;
  if (db === undefined || blobs === undefined || engine === undefined || actorsFile === undefined) {
    throw new UsageError("serve needs --db, --blobs, --engine and --actors");
  }
  const port = count("--port", values.port, 8787, 0);
  const size = count("--pool", values.pool, 2, 1);
  const staticDir = directory("--static-dir", values["static-dir"]) ?? BUILT_UI;
  const wasmDir = directory("--wasm-dir", values["wasm-dir"]);
  const packDir = directory("--pack", values.pack);
  const defaultRoom = id("--default-room", values["default-room"]);
  const workspaceId = id("--workspace-id", values["workspace-id"]);
  const { actors, operatorOf } = await loadActorDirectory(actorsFile);
  const founder = [...actors.values()].find((actor) => actor.kind === "user");
  if (defaultRoom !== null && founder === undefined) throw new UsageError("--default-room needs a user in the actors file to create the room");

  // One pool of engine workers for the rooms, the MCP tools and the pack.
  const pool = new WorkerPool({ command: [engine, "reactor-serve"], size });
  const documents = new PoolEngine(pool);
  const server = new RoomServer({ dbPath: db, blobDir: blobs, engine: documents, operatorOf });
  if (defaultRoom !== null && founder !== undefined && !(await server.listRooms()).some((room) => room.room_id === defaultRoom)) {
    const created = await server.createRoom(founder, { room_id: defaultRoom, workspace_id: workspaceId ?? "default" });
    if (!created.ok) {
      io.err(`error: cannot create the room ${defaultRoom}: ${created.error.code}: ${created.error.message}`);
      await server.close();
      return EXIT_ERROR;
    }
  }
  const workspace = startWorkspaceServer({
    service: server,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (actors.get(token) ?? null);
    },
    port,
    hostname: values.host,
    staticDir,
    wasmDir,
    snapshot: engineSnapshot(pool),
    mcp: { inspector: engineInspector(pool), renderer: engineRenderer(pool) },
    pack: packDir === null ? null : { dir: packDir, evaluator: new PoolXlsxEvaluator(pool), engine: documents },
    defaultRoom,
    workspaceId,
  });
  io.out(`listening ${workspace.wsUrl}`);
  io.out(`workspace ${staticDir === null ? "(UI not built)" : workspace.url}`);
  io.out(`mcp ${workspace.mcpUrl}`);
  const stopped = Promise.withResolvers<void>();
  process.once("SIGINT", stopped.resolve);
  process.once("SIGTERM", stopped.resolve);
  await stopped.promise;
  await workspace.stop();
  await server.close();
  return EXIT_FRESH;
}

export async function runCli(argv: readonly string[], io: CliIo = STDIO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "check":
      case "refresh":
        return await runPack(command, rest, io);
      case "serve":
        return await runServe(rest, io);
      case "seats":
        return runSeats(rest, io);
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return EXIT_FRESH;
      case undefined:
        io.err(USAGE);
        return EXIT_ERROR;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const parseError = e instanceof TypeError && "code" in e && typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS");
    io.err(e instanceof UsageError || parseError ? `error: ${message}\n\n${USAGE}` : `error: ${message}`);
    return EXIT_ERROR;
  }
}
