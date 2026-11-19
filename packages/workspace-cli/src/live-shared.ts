// What the live editors of a document (`live-cells.ts` for workbooks, `live-slide-text.ts` for decks) share: what a route
// sends back, the digests of the bytes an editor may write, a small LRU, one write at a time for each document, the
// proof that the history since a read is all there, and the way a head is opened and closed in an engine worker.
import type { RoomActor, RoomHead, RoomSessionEntry } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type EngineWorker, type RoomFailure, type RoomService } from "@wolfsdk/server";

/** Who is calling, as the route resolved it from the token: a member, never a guest or an agent. */
export type LiveCaller = {
  roomId: string;
  doc: string;
  actor: RoomActor;
  /** The refusal of a write now (a read-only workspace), or `null`. */
  refusal: RoomFailure | null;
};

export type LiveError = { status: number; error: { code: string; message: string; [member: string]: unknown } };

/** What the route sends: a JSON body, an empty 204, an error body with its status, or a failure of the room service. */
export type LiveReply = { status: 200; body: unknown } | { status: 204 } | LiveError | { failure: RoomFailure };

export const STRUCTURE_CONFLICT = "STRUCTURE_CONFLICT";

export const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): LiveError => ({ status, error: { code, message, ...extra } });
export const bad = (message: string): LiveError => fail(400, "BAD_REQUEST", message);

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The reply for what the engine said no to or could not do; anything else is a bug and is thrown on. */
export function engineReply(e: unknown): LiveReply {
  if (e instanceof EngineRefusal) return { failure: { code: e.isEngineFailure || e.isLicense ? "ENGINE_FAILED" : "BAD_REQUEST", message: e.message } };
  if (e instanceof EngineFault) return { failure: { code: "ENGINE_FAILED", message: e.message } };
  throw e;
}

/** Least-recently-used map, for what is cheap to read again. */
export class Lru<V> {
  readonly #map = new Map<string, V>();
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value as string);
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
}

/** The digests of the bytes an editor writes. The operator's are fixed; the digests of the editor's own writes are kept
 * up to a limit, oldest out first: a head that dropped out needs attesting again. */
export class Writable {
  readonly #attested: ReadonlySet<string>;
  readonly #inherited: Lru<true>;
  constructor(attested: readonly string[], inheritedCap: number) {
    for (const digest of attested) {
      if (!/^[0-9a-f]{64}$/i.test(digest)) throw new RangeError(`${JSON.stringify(digest)} is not a sha256 digest (64 hexadecimal digits)`);
    }
    this.#attested = new Set(attested.map((digest) => digest.toLowerCase()));
    this.#inherited = new Lru<true>(inheritedCap);
  }
  has(sha256: string): boolean {
    return this.#attested.has(sha256) || this.#inherited.has(sha256);
  }
  inherit(sha256: string): void {
    this.#inherited.set(sha256, true);
  }
}

/** Writes to one document go one at a time, so that members writing different parts together do not race each other for
 * the revision. A write of another kind can still win it: the editor retries those. */
export class WriteQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(roomId: string, doc: string, job: () => Promise<T>): Promise<T> {
    const key = `${roomId}\0${doc}`;
    const turn = (this.#tails.get(key) ?? Promise.resolve()).then(job);
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return turn;
  }
}

/** Most revisions a write is rebased over. */
export const MAX_REBASE = 256;

/** The entries of the session log, in order, that took the document from `baseRevision` to `head`, or the reason that
 * is not proven. Everything committed after the base must be there, one for each revision, in an unbroken chain of
 * digests that starts at the bytes of the base and ends at the head bytes: a span that is not all there is not known to
 * be anything. What the entries did is for the caller to prove. `subject` names the document in the words of a refusal,
 * and `changed` is the refusal for a chain that does not hold. */
export function provenSpan(log: readonly RoomSessionEntry[], baseRevision: number, head: RoomHead, subject: string, changed: string): RoomSessionEntry[] | string {
  const span = head.revision - baseRevision;
  if (span > MAX_REBASE) return `the ${subject} has ${span} newer revisions than your read: read it again`;
  const entries = log.filter((entry) => entry.revision > baseRevision && entry.revision <= head.revision).sort((a, b) => a.revision - b.revision);
  if (entries.length !== span || entries.some((entry, i) => entry.revision !== baseRevision + 1 + i)) return changed;
  // The entry before the first one pins the revision of the read to the bytes the chain starts from.
  const anchor = baseRevision === 0 ? null : log.find((entry) => entry.revision === baseRevision);
  if (baseRevision > 0 && (anchor === undefined || anchor === null || entries[0]!.base_sha256 !== anchor.result_sha256)) return changed;
  for (let i = 1; i < entries.length; i++) if (entries[i]!.base_sha256 !== entries[i - 1]!.result_sha256) return changed;
  if (entries.length > 0 && entries[entries.length - 1]!.result_sha256 !== head.sha256) return changed;
  return entries;
}

/** The entries of the session log that are this document's, or why the room could not be read. */
export async function documentLog(service: RoomService, caller: LiveCaller): Promise<RoomSessionEntry[] | { failure: RoomFailure }> {
  const room = await service.getRoom(caller.roomId, caller.actor);
  if (!room.ok) return { failure: room.error };
  return room.value.session_log.filter((entry) => entry.doc_name === caller.doc);
}

/** A worker that cannot say it closed the document is not reused. */
export async function closeDocument(worker: EngineWorker, doc: number): Promise<void> {
  try {
    const { body } = await worker.call({ cmd: "close", doc });
    if (!body.ok || "error" in body) worker.discard();
  } catch {
    worker.discard();
  }
}
