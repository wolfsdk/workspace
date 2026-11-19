// Who may connect to `serve`: a JSON file that maps each bearer token to the actor it stands for,
// `{ "<token>": { "kind": "user", "id": "alice", "name": "Alice" } }`. An agent entry may also carry
// `"operator": { "id": "alice", "name": "Alice" }` so it acts on its operator's seat instead of taking
// a seat of its own. Any entry may carry `"guest": { "docs": [ { "room": "<room id>", "doc": "<document name>" } ] }`:
// the actor is then a guest, limited to those documents, and takes no seat. An agent with no `guest` whose operator is
// a guest user of the file is limited to the documents of that user. The server derives the actor, operator and limits
// of a connection from the token file alone; nothing a client says about itself inside the socket is trusted.
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, linkSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import type { AccessScope } from "@wolfsdk/server";
import { UsageError } from "./errors.ts";

const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ActorOperator = { id: string; name: string };

export type ActorDirectory = {
  actors: Map<string, RoomActor>;
  operatorOf: (agent: RoomActor) => ActorOperator | null;
  /** What `actor` may reach when it is a guest: its documents, with `propose` access. `null` for a member. */
  scopeOf: (actor: RoomActor) => AccessScope | null;
};

/** The most documents one guest entry may list. */
const MAX_GUEST_DOCS = 50;

function isOperator(value: unknown): value is ActorOperator {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => k === "id" || k === "name") &&
    "id" in value &&
    typeof value.id === "string" &&
    ACTOR_ID.test(value.id) &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name !== ""
  );
}

type ParsedEntry = { actor: RoomActor; operator: ActorOperator | null; guest: AccessScope | null };

/** The scope of a `guest` field: 1 to 50 documents, each a room id and a non-empty document name, and nothing else. */
function parseGuest(path: string, id: string, value: unknown): AccessScope {
  const shape = `${path}: guest of ${id} must be {"docs": [{"room": <room id>, "doc": <document name>}]} with 1 to ${MAX_GUEST_DOCS} documents`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UsageError(shape);
  const keys = Object.keys(value);
  if (!keys.every((k) => k === "docs")) throw new UsageError(`${path}: unknown field on the guest of ${id} (${keys.filter((k) => k !== "docs").join(", ")})`);
  const docs: unknown = "docs" in value ? value.docs : undefined;
  if (!Array.isArray(docs) || docs.length < 1 || docs.length > MAX_GUEST_DOCS) throw new UsageError(shape);
  const scoped: { room_id: string; doc_name: string }[] = [];
  for (const doc of docs) {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new UsageError(shape);
    const pair = doc as Record<string, unknown>;
    const extra = Object.keys(pair).filter((k) => k !== "room" && k !== "doc");
    if (extra.length > 0) throw new UsageError(`${path}: unknown field on a document of the guest of ${id} (${extra.join(", ")})`);
    if (typeof pair.room !== "string" || !ACTOR_ID.test(pair.room) || typeof pair.doc !== "string" || pair.doc === "") throw new UsageError(shape);
    scoped.push({ room_id: pair.room, doc_name: pair.doc });
  }
  return { access: "propose", docs: scoped };
}

function parseEntry(path: string, value: unknown): ParsedEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${path}: the actor of a token must be {"kind": "user" | "agent", "id": <id>, "name": <text>}`);
  }
  const keys = Object.keys(value);
  if (!keys.every((k) => k === "kind" || k === "id" || k === "name" || k === "operator" || k === "guest")) {
    throw new UsageError(`${path}: unknown field on actor entry (${keys.join(", ")})`);
  }
  const rec = value as Record<string, unknown>;
  if ((rec.kind !== "user" && rec.kind !== "agent") || typeof rec.id !== "string" || !ACTOR_ID.test(rec.id) || typeof rec.name !== "string" || rec.name === "") {
    throw new UsageError(`${path}: the actor of a token must be {"kind": "user" | "agent", "id": <id>, "name": <text>} with an id of letters, digits and . _ : -`);
  }
  const guest = rec.guest === undefined ? null : parseGuest(path, rec.id, rec.guest);
  const actor: RoomActor = { kind: rec.kind, id: rec.id, name: rec.name };
  if (rec.operator === undefined) return { actor, operator: null, guest };
  if (rec.kind !== "agent") {
    throw new UsageError(`${path}: only an agent entry may name an operator (${rec.id})`);
  }
  if (!isOperator(rec.operator)) {
    throw new UsageError(`${path}: operator of agent ${rec.id} must be {"id": <id>, "name": <text>}`);
  }
  return { actor, operator: { id: rec.operator.id, name: rec.operator.name }, guest };
}

/** The documents of a scope as one comparable text, whatever their order. */
const scopeKey = (scope: AccessScope | null): string =>
  scope === null ? "" : JSON.stringify(scope.docs.map((d) => [d.room_id, d.doc_name]).sort((a, b) => (a[0]! + "\0" + a[1]!).localeCompare(b[0]! + "\0" + b[1]!)));

/** The actors, agent-operator bindings and guest scopes in the `text` of the file at `path`. */
function parseActorDirectory(path: string, text: string): ActorDirectory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`cannot read the actors file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${path} must be a JSON object that maps each token to an actor`);
  }
  const actors = new Map<string, RoomActor>();
  const operators = new Map<string, ActorOperator | null>();
  /** The scope each identity has, by `<kind>:<id>`: an identity is one guest or one member whatever token it signs in with. */
  const scopes = new Map<string, AccessScope | null>();
  for (const [token, value] of Object.entries(parsed)) {
    if (token === "") throw new UsageError(`${path}: a token is empty`);
    const { actor, operator, guest } = parseEntry(path, value);
    if (actor.kind === "agent") {
      const prev = operators.get(actor.id);
      if (prev !== undefined && (prev?.id !== operator?.id || prev?.name !== operator?.name)) {
        throw new UsageError(`${path}: agent ${actor.id} has conflicting operator bindings across tokens`);
      }
      operators.set(actor.id, operator);
    }
    const identity = `${actor.kind}:${actor.id}`;
    if (scopes.has(identity) && scopeKey(scopes.get(identity) ?? null) !== scopeKey(guest)) {
      throw new UsageError(`${path}: ${actor.kind} ${actor.id} has conflicting guest documents across tokens`);
    }
    scopes.set(identity, guest);
    actors.set(token, actor);
  }
  if (actors.size === 0) throw new UsageError(`${path} names no actor: nobody could connect`);
  // An agent that names no documents of its own is limited as its operator is.
  for (const actor of actors.values()) {
    const operator = actor.kind === "agent" ? (operators.get(actor.id) ?? null) : null;
    if (operator !== null && scopes.get(`agent:${actor.id}`) === null) scopes.set(`agent:${actor.id}`, scopes.get(`user:${operator.id}`) ?? null);
  }
  return {
    actors,
    operatorOf: (agent) => (agent.kind === "agent" ? (operators.get(agent.id) ?? null) : null),
    scopeOf: (actor) => scopes.get(`${actor.kind}:${actor.id}`) ?? null,
  };
}

/** The actors and agent-operator bindings of the file at `path`. */
export async function loadActorDirectory(path: string): Promise<ActorDirectory> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read the actors file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseActorDirectory(path, text);
}

/** An actors file that `serve` keeps in step with the disk. */
export type WatchedActors = {
  /** The directory in force now. When the file's identity, size or modification time differs from the last
   * time this looked (one `stat`, nothing else), the file is read again: a file that parses and validates
   * replaces the directory, one that does not (half written, not JSON, no actor, gone) leaves the last good
   * directory in force and is reported once through `log`. */
  current(): ActorDirectory;
};

/** What identifies one version of the file: a writer that replaces it by rename changes the inode, one that
 * rewrites it in place changes the modification time or size. An unreadable file is a stamp of its own. */
function stampOf(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (e) {
    return `unreadable:${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Read the actors file at `path` now, and again whenever it changes, for as long as the result is used.
 * The first read throws like `loadActorDirectory` does: a server must not start with nobody who can connect. */
export async function watchActorDirectory(path: string, log: (line: string) => void): Promise<WatchedActors> {
  // The stamp comes first: a change that lands during the read is then seen by the next check.
  let seen = stampOf(path);
  let directory = await loadActorDirectory(path);
  return {
    current() {
      const stamp = stampOf(path);
      if (stamp === seen) return directory;
      seen = stamp;
      try {
        directory = parseActorDirectory(path, readFileSync(path, "utf8"));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log(`actors file changed but cannot be used, keeping the ${directory.actors.size} token${directory.actors.size === 1 ? "" : "s"} read before: ${reason.replace(/\s+/g, " ")}`);
      }
      return directory;
    },
  };
}

/** The actors of the file at `path`, by token. */
export async function loadActors(path: string): Promise<Map<string, RoomActor>> {
  return (await loadActorDirectory(path)).actors;
}

/** Who to add to an actors file. `operator` is the id of a user of the file, and only an agent has one. */
export type NewActor = { kind: "user" | "agent"; id: string; name: string; operator: string | null };

/** What `addActor` wrote: the token, shown to nobody else, and whether the file was made by this call. */
export type AddedActor = { token: string; actor: RoomActor; operator: ActorOperator | null; created: boolean };

/** A new bearer token: 32 random bytes as 64 hex digits. */
export function mintToken(): string {
  return randomBytes(32).toString("hex");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The entries of the actors file at `path`, or `null` when there is no file. A file that is there must be one
 * `serve` accepts (or `{}`): an edit never builds on a file that does not work. */
function readEntries(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw new Error(`cannot read the actors file ${path}: ${errorText(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`cannot read the actors file ${path}: ${errorText(e)}`);
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return {};
  parseActorDirectory(path, text);
  return parsed as Record<string, unknown>;
}

/** Add one actor under a new token to the actors file at `path`, made when it is not there. The file is written
 * whole beside itself with mode 600 and renamed over the old one, so a running `serve` sees either the old file or
 * the new one and takes the token from its next request. A file that is new is linked into place, so a file that
 * appeared in the meantime is never overwritten. Refuses an id that the file has for the same kind, and an
 * operator that is not a user of the file. */
export function addActor(path: string, wanted: NewActor): AddedActor {
  if (!ACTOR_ID.test(wanted.id)) throw new UsageError(`the id ${JSON.stringify(wanted.id)} must be 1 to 128 letters, digits and . _ : - starting with a letter or digit`);
  if (wanted.name.trim() === "") throw new UsageError("the name must not be blank");
  if (wanted.operator !== null && wanted.kind !== "agent") throw new UsageError("only an agent has an operator");
  const entries = readEntries(path);
  const values = Object.values(entries ?? {}) as { kind: string; id: string; name: string }[];
  if (values.some((v) => v.kind === wanted.kind && v.id === wanted.id)) {
    throw new Error(`${path} already has ${wanted.kind} ${wanted.id}; choose another id`);
  }
  let operator: ActorOperator | null = null;
  if (wanted.operator !== null) {
    const user = values.find((v) => v.kind === "user" && v.id === wanted.operator);
    if (user === undefined) throw new Error(`${path} has no user ${wanted.operator} to operate the agent; add the user first`);
    operator = { id: user.id, name: user.name };
  }
  const actor: RoomActor = { kind: wanted.kind, id: wanted.id, name: wanted.name };
  let token = mintToken();
  while (entries !== null && token in entries) token = mintToken();
  const next = { ...entries, [token]: operator === null ? actor : { ...actor, operator } };

  // Through a symbolic link, the file it points at is the one replaced, in its own folder.
  const target = entries === null ? path : realpathSync(path);
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    if (entries === null) {
      linkSync(temporary, target);
      unlinkSync(temporary);
    } else {
      // Root editing the file of the server's user (`docker exec` as root) leaves it that user's.
      const { uid, gid } = statSync(target);
      if (process.getuid?.() === 0) chownSync(temporary, uid, gid);
      renameSync(temporary, target);
    }
  } catch (e) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone: renamed into place, or never written.
    }
    throw new Error(`cannot write the actors file ${path}: ${errorText(e)}`);
  }
  return { token, actor, operator, created: entries === null };
}
