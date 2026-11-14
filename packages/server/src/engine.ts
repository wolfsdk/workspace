// What the room server asks of the engine, and how that maps onto reactor pipe commands. The server never
// edits a document itself: it opens the head bytes in a worker, applies the batches, saves, and checks every
// hash the worker reports against the bytes it actually got. A worker that lies about a hash is a fault.
import type {
  ReactorPipeCommand,
  ReactorPipeEntitlement,
  ReactorPipeRequest,
  ReactorPipeResponse,
  RoomBatch,
  WorkspaceDocFormat,
} from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import type { EngineWorker, WorkerPool } from "./pool.ts";

export type ReplayInput = {
  format: WorkspaceDocFormat;
  name: string;
  /** The document as it is now: the head bytes, or empty for a dry run that does not need them saved. */
  bytes: Uint8Array;
  /** Applied in order, each on the result of the one before. May be empty. Each batch runs under the clock,
   * timezone, locale and seed it names; a member it does not name keeps the engine's current value. */
  batches: readonly RoomBatch[];
  /** Return the bytes after the last batch (or the input bytes when there is no batch). */
  save: boolean;
  /** Return the page hashes after the last batch. */
  pages: boolean;
};

export type ReplayStep = { base_sha256: string; sha256: string };

export type ReplayResult = {
  format: WorkspaceDocFormat;
  /** SHA-256 of the input bytes, as the worker computed it (and as the host checked it). */
  base_sha256: string;
  /** One per batch. */
  steps: ReplayStep[];
  /** Present when `save` was asked for. Their SHA-256 is the last step's `sha256`. */
  bytes: Uint8Array | null;
  /** Present when `pages` was asked for and the format has pages the worker can hash. */
  page_hashes: string[] | null;
};

export interface DocumentEngine {
  /** What the engine is licensed for. */
  entitlement(): Promise<ReactorPipeEntitlement>;

  /** Open `bytes`, apply `batches`, report. Throws `EngineRefusal` when the engine answered no and
   * `EngineFault` when it could not be trusted to answer. Nothing outside the worker changes either way. */
  replay(input: ReplayInput): Promise<ReplayResult>;

  close(): Promise<void>;
}

type Answer<C extends ReactorPipeCommand> = Extract<ReactorPipeResponse, { cmd: C }>;

function refusalOf(body: ReactorPipeResponse, cmd: ReactorPipeCommand): EngineRefusal | null {
  if (!("error" in body) || body.error === undefined) return null;
  return new EngineRefusal(body.error.code, body.error.message, body.cmd ?? cmd, body.error.argument);
}

/** The response to `request`, narrowed to its command, or an `EngineRefusal`. */
async function ask<C extends ReactorPipeCommand>(
  worker: EngineWorker,
  request: ReactorPipeRequest & { cmd: C },
  segments: readonly Uint8Array[] = [],
): Promise<{ body: Answer<C>; segments: Uint8Array[] }> {
  const { body, segments: out } = await worker.call(request, segments);
  const refusal = refusalOf(body, request.cmd);
  if (refusal) throw refusal;
  if (body.cmd !== request.cmd) throw new EngineFault(`worker answered ${String(body.cmd)} to ${request.cmd}`);
  return { body: body as Answer<C>, segments: out };
}

/** The typed errors of a failed `apply`, which the contract leaves inside `receipt`. */
function receiptRefusal(receipt: Record<string, unknown>): EngineRefusal {
  const errors = receipt.errors;
  const first = Array.isArray(errors) ? errors[0] : receipt.error;
  if (typeof first === "object" && first !== null && "code" in first && "message" in first) {
    const { code, message } = first;
    if (typeof code === "string" && typeof message === "string") return new EngineRefusal(code, message, "apply");
  }
  return new EngineRefusal("apply-failed", `the engine did not commit the batch: ${JSON.stringify(receipt).slice(0, 300)}`, "apply");
}

export class PoolEngine implements DocumentEngine {
  private readonly pool: WorkerPool;

  constructor(pool: WorkerPool) {
    this.pool = pool;
  }

  entitlement(): Promise<ReactorPipeEntitlement> {
    return this.pool.withWorker(async (worker) => {
      const { body } = await ask(worker, { cmd: "entitlement" });
      const { tier, max_workspaces, max_seats, sso, oem_offline_wasm, key_id, expires_at } = body;
      return { tier, max_workspaces, max_seats, sso, oem_offline_wasm, key_id, expires_at };
    });
  }

  replay(input: ReplayInput): Promise<ReplayResult> {
    return this.pool.withWorker((worker) => this.replayOn(worker, input));
  }

  /** Replay with the pages asked for. An `unsupported` refusal of a relayout apply is either an op the engine does
   * not support or a document it edits but cannot lay out. The same replay without pages tells them apart: it
   * refuses the first again, and for the second the document simply has no page hashes. It runs on a fresh
   * handle, because the engine may have changed the document before it refused the relayout. */
  private async replayOn(worker: EngineWorker, input: ReplayInput): Promise<ReplayResult> {
    try {
      return await this.replayOnce(worker, input);
    } catch (e) {
      if (!input.pages || !(e instanceof EngineRefusal) || e.code !== "unsupported" || e.cmd !== "apply") throw e;
      return this.replayOnce(worker, { ...input, pages: false });
    }
  }

  private async replayOnce(worker: EngineWorker, input: ReplayInput): Promise<ReplayResult> {
    const inputSha = sha256Hex(input.bytes);
    const opened = await ask(
      worker,
      { cmd: "open", bytes: { bin: 0, len: input.bytes.length }, name: input.name, format: input.format },
      [input.bytes],
    );
    const doc = opened.body.doc;
    try {
      if (opened.body.format !== input.format) {
        throw new EngineRefusal("format-mismatch", `the engine opened ${input.name} as ${opened.body.format}, not ${input.format}`, "open");
      }
      if (opened.body.sha256 !== inputSha) {
        throw new EngineFault(`worker reports sha256 ${opened.body.sha256} for bytes that hash to ${inputSha}`);
      }
      const steps: ReplayStep[] = [];
      let at = inputSha;
      let pages: string[] | null = null;
      for (const batch of input.batches) {
        const request: ReactorPipeRequest = { cmd: "apply", doc, ops: batch.ops, relayout: input.pages };
        if (batch.clock !== undefined) request.clock = batch.clock;
        if (batch.timezone !== undefined) request.timezone = batch.timezone;
        if (batch.locale !== undefined) request.locale = batch.locale;
        if (batch.seed !== undefined) request.seed = batch.seed;
        const { body } = await ask(worker, request);
        if (!body.ok || !body.committed) throw receiptRefusal(body.receipt);
        if (body.base_sha256 !== undefined && body.base_sha256 !== at) {
          throw new EngineFault(`worker applied a batch on ${body.base_sha256}, not on ${at}`);
        }
        steps.push({ base_sha256: at, sha256: body.sha256 });
        at = body.sha256;
        pages = body.pages ? body.pages.hashes : null;
      }
      let bytes: Uint8Array | null = null;
      if (input.save) {
        if (input.batches.length === 0) {
          bytes = input.bytes;
        } else {
          const saved = await ask(worker, { cmd: "save", doc });
          const blob = saved.segments[saved.body.bytes.bin];
          if (!blob) throw new EngineFault("save response has no bytes segment");
          const savedSha = sha256Hex(blob);
          if (savedSha !== saved.body.sha256 || savedSha !== at) {
            throw new EngineFault(`worker saved bytes that hash to ${savedSha}; it reported ${saved.body.sha256} after applying ${at}`);
          }
          bytes = blob;
        }
      }
      if (input.pages && pages === null) pages = await this.layoutPages(worker, doc);
      return { format: opened.body.format, base_sha256: opened.body.sha256, steps, bytes, page_hashes: input.pages ? pages : null };
    } finally {
      await this.closeDoc(worker, doc);
    }
  }

  /** Page hashes from `layout`; `null` for a format the worker does not lay out. */
  private async layoutPages(worker: EngineWorker, doc: number): Promise<string[] | null> {
    try {
      const { body } = await ask(worker, { cmd: "layout", doc });
      return body.page_hashes;
    } catch (e) {
      if (e instanceof EngineRefusal && e.code === "unsupported") return null;
      throw e;
    }
  }

  /** Release the handle. A worker that cannot say it closed it is not reused. */
  private async closeDoc(worker: EngineWorker, doc: number): Promise<void> {
    try {
      const { body } = await worker.call({ cmd: "close", doc });
      if (!body.ok || "error" in body) worker.discard();
    } catch {
      // The connection broke, which already discarded the worker.
      worker.discard();
    }
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}
