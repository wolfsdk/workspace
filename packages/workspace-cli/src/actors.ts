// Who may connect to `serve`: a JSON file that maps each bearer token to the actor it stands for,
// `{ "<token>": { "kind": "user", "id": "alice", "name": "Alice" } }`. An agent entry may also carry
// `"operator": { "id": "alice", "name": "Alice" }` so it acts on its operator's seat instead of taking
// a seat of its own. The server derives the actor and operator of a connection from the token file alone;
// nothing a client says about itself inside the socket is trusted.
import { readFile } from "node:fs/promises";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { UsageError } from "./errors.ts";

const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ActorOperator = { id: string; name: string };

export type ActorDirectory = {
  actors: Map<string, RoomActor>;
  operatorOf: (agent: RoomActor) => ActorOperator | null;
};

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

function parseEntry(path: string, value: unknown): { actor: RoomActor; operator: ActorOperator | null } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${path}: the actor of a token must be {"kind": "user" | "agent", "id": <id>, "name": <text>}`);
  }
  const keys = Object.keys(value);
  if (!keys.every((k) => k === "kind" || k === "id" || k === "name" || k === "operator")) {
    throw new UsageError(`${path}: unknown field on actor entry (${keys.join(", ")})`);
  }
  const rec = value as Record<string, unknown>;
  if ((rec.kind !== "user" && rec.kind !== "agent") || typeof rec.id !== "string" || !ACTOR_ID.test(rec.id) || typeof rec.name !== "string" || rec.name === "") {
    throw new UsageError(`${path}: the actor of a token must be {"kind": "user" | "agent", "id": <id>, "name": <text>} with an id of letters, digits and . _ : -`);
  }
  if (rec.operator === undefined) {
    return { actor: { kind: rec.kind, id: rec.id, name: rec.name }, operator: null };
  }
  if (rec.kind !== "agent") {
    throw new UsageError(`${path}: only an agent entry may name an operator (${rec.id})`);
  }
  if (!isOperator(rec.operator)) {
    throw new UsageError(`${path}: operator of agent ${rec.id} must be {"id": <id>, "name": <text>}`);
  }
  return {
    actor: { kind: rec.kind, id: rec.id, name: rec.name },
    operator: { id: rec.operator.id, name: rec.operator.name },
  };
}

/** The actors and agent-operator bindings of the file at `path`. */
export async function loadActorDirectory(path: string): Promise<ActorDirectory> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read the actors file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${path} must be a JSON object that maps each token to an actor`);
  }
  const actors = new Map<string, RoomActor>();
  const operators = new Map<string, ActorOperator | null>();
  for (const [token, value] of Object.entries(parsed)) {
    if (token === "") throw new UsageError(`${path}: a token is empty`);
    const { actor, operator } = parseEntry(path, value);
    if (actor.kind === "agent") {
      const prev = operators.get(actor.id);
      if (prev !== undefined && (prev?.id !== operator?.id || prev?.name !== operator?.name)) {
        throw new UsageError(`${path}: agent ${actor.id} has conflicting operator bindings across tokens`);
      }
      operators.set(actor.id, operator);
    }
    actors.set(token, actor);
  }
  if (actors.size === 0) throw new UsageError(`${path} names no actor: nobody could connect`);
  return {
    actors,
    operatorOf: (agent) => (agent.kind === "agent" ? (operators.get(agent.id) ?? null) : null),
  };
}

/** The actors of the file at `path`, by token. */
export async function loadActors(path: string): Promise<Map<string, RoomActor>> {
  return (await loadActorDirectory(path)).actors;
}
