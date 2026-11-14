// Shared set-up of the tests of the room server: a temporary directory, a worker pool over the stand-in
// reactor, a room server on top of both, and a collector that remembers (and checks) every event.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "bun:test";
import {
  type RoomActor,
  type RoomHead,
  type RoomProposal,
  type RoomServerEvent,
  type RoomSessionEntry,
  type RoomState,
  validateRoomEvent,
  validateRoomSnapshot,
} from "@wolfsdk/protocol/workspace";
import { type EditOutcome, PoolEngine, RoomServer, type Result, type RoomFailure, WorkerPool, type RoomServerOptions } from "../../src/index.ts";

export const FAKE_REACTOR = fileURLToPath(new URL("./fake-reactor.ts", import.meta.url));

export const alice: RoomActor = { kind: "user", id: "alice", name: "Alice" };
export const bob: RoomActor = { kind: "user", id: "bob", name: "Bob" };
export const robot: RoomActor = { kind: "agent", id: "robot", name: "Robot" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const bytesOf = (text: string): Uint8Array => encoder.encode(text);
export const textOf = (bytes: Uint8Array): string => decoder.decode(bytes);
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The value of a call that must have succeeded; the failure otherwise. */
export function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The error of the class `kind` that `promise` rejects with; no failure, or another one, fails the test. */
export async function failureOf<E extends Error>(promise: Promise<unknown>, kind: new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof kind) return e;
    throw e;
  }
  throw new Error(`expected a ${kind.name}, but the call succeeded`);
}

export type Harness = {
  dir: string;
  pool: WorkerPool;
  server: RoomServer;
  /** Stop the server and start another one on the same files (a restart). */
  restart(): Promise<void>;
  /** Stop everything and delete the files. */
  dispose(): Promise<void>;
};

export type HarnessOptions = {
  /** Environment of the stand-in reactor (`FAKE_TIER`, `FAKE_MAX_SEATS`, ...). */
  env?: Record<string, string>;
  poolSize?: number;
  callTimeoutMs?: number;
  replayWindow?: number;
  authorize?: RoomServerOptions["authorize"];
  timezone?: RoomServerOptions["timezone"];
  locale?: RoomServerOptions["locale"];
  seed?: RoomServerOptions["seed"];
  operatorOf?: RoomServerOptions["operatorOf"];
  /** The server's clock. Default: a `steppingClock`. */
  now?: RoomServerOptions["now"];
};

/** A deterministic clock: every reading is one second after the one before. */
export function steppingClock(start = "2026-11-13T10:00:00.000Z"): () => Date {
  let at = Date.parse(start);
  return () => {
    const reading = new Date(at);
    at += 1000;
    return reading;
  };
}

export function makePool(options: HarnessOptions = {}): WorkerPool {
  return new WorkerPool({
    command: [process.execPath, FAKE_REACTOR],
    env: options.env,
    size: options.poolSize ?? 2,
    callTimeoutMs: options.callTimeoutMs ?? 20_000,
  });
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "wolfsdk-server-"));
  // The clock and the id counter live across restarts, as they would across a real day.
  const clock = options.now ?? steppingClock();
  let counter = 0;
  const start = (): { pool: WorkerPool; server: RoomServer } => {
    const pool = makePool(options);
    const server = new RoomServer({
      dbPath: join(dir, "rooms.sqlite"),
      blobDir: join(dir, "blobs"),
      engine: new PoolEngine(pool),
      now: clock,
      newId: () => `id-${++counter}`,
      replayWindow: options.replayWindow,
      authorize: options.authorize,
      timezone: options.timezone,
      locale: options.locale,
      seed: options.seed,
      operatorOf: options.operatorOf,
    });
    return { pool, server };
  };
  const harness: Harness = {
    dir,
    ...start(),
    async restart() {
      await harness.server.close();
      Object.assign(harness, start());
    },
    async dispose() {
      await harness.server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** A room with one document, ready to be edited: `room` in workspace `ws`, `doc.docx` holding `hello world`. */
export async function seedRoom(h: Harness, text = "hello world"): Promise<void> {
  must(await h.server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
  must(await h.server.addDocument("room", alice, { name: "doc.docx", format: "docx", bytes: bytesOf(text) }));
}

/** A listener that keeps every event it is given. */
export class Collector {
  readonly events: RoomServerEvent[] = [];
  readonly listener = (event: RoomServerEvent): void => {
    this.events.push(event);
  };

  /** The events of one type, in the order they arrived. */
  ofType<T extends RoomServerEvent["type"]>(type: T): Extract<RoomServerEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<RoomServerEvent, { type: T }> => e.type === type);
  }

  /** Every event passes the validator of the contract, and `seq` never goes back. */
  expectValid(): void {
    let seq = -1;
    for (const event of this.events) {
      expect(validateRoomEvent(event)).toEqual([]);
      if (event.type === "error") continue;
      expect(event.seq).toBeGreaterThan(seq);
      seq = event.seq;
    }
  }
}

/** The room as the server states it, checked against the contract on the way out. */
export async function snapshotOf(h: Harness, roomId = "room"): Promise<RoomState> {
  const room = must(await h.server.getRoom(roomId, alice));
  expect(validateRoomSnapshot(room)).toEqual([]);
  return room;
}

/** The refusal of a call that must have failed; a success fails the test. */
export function refusalOf<T>(result: Result<T>): RoomFailure {
  if (result.ok) throw new Error("expected a refusal, but the call succeeded");
  return result.error;
}

/** The head and entry of an edit that must have been a commit. */
export function committed(result: Result<EditOutcome>): { head: RoomHead; entry: RoomSessionEntry } {
  const outcome = must(result);
  if (outcome.mode !== "commit") throw new Error("expected a commit, got a proposal");
  return outcome;
}

/** The proposal of an edit that must have been a proposal. */
export function proposed(result: Result<EditOutcome>): RoomProposal {
  const outcome = must(result);
  if (outcome.mode !== "propose") throw new Error("expected a proposal, got a commit");
  return outcome.proposal;
}
