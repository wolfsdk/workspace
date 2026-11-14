// A pool of engine processes. Each worker is one child process that speaks `wolfsdk.reactor-pipe.v1` over
// framed stdin/stdout. A job leases a worker exclusively, so the document handles a job opens are its own.
// A worker that faults (crash, timeout, malformed or invalid frame) is killed and replaced lazily; the job
// that saw the fault fails and the pool serves the next one with a fresh process.
import type { ReactorPipeRequest } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal } from "./errors.ts";
import { PipeConnection, type PipeResult, type PipeTransport } from "./pipe.ts";

export type WorkerPoolOptions = {
  /** The executable and its arguments, e.g. `["wolf", "reactor-serve"]`. */
  command: readonly string[];
  /** Extra environment for the worker, on top of this process's. */
  env?: Record<string, string>;
  /** Most workers alive at once, and so most jobs running at once. Default 2. */
  size?: number;
  /** How long a worker may take to answer one request. Default 30 s. */
  callTimeoutMs?: number;
  maxSegmentBytes?: number;
};

/** What a job sees of its leased worker. */
export interface EngineWorker {
  call(request: ReactorPipeRequest, segments?: readonly Uint8Array[]): Promise<PipeResult>;
  /** Kill this worker when the job ends, even if the job succeeds (state the job could not clean up). */
  discard(): void;
}

const STDERR_TAIL_BYTES = 4096;

/** One child process and the connection to it. */
class Worker implements EngineWorker {
  readonly connection: PipeConnection;
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private stderrTail = "";
  private discarded = false;
  exited = false;

  constructor(options: WorkerPoolOptions) {
    this.process = Bun.spawn([...options.command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...options.env },
    });
    void this.process.exited.then(() => {
      this.exited = true;
    });
    void this.drainStderr();
    const proc = this.process;
    const transport: PipeTransport = {
      write: async (bytes) => {
        proc.stdin.write(bytes);
        await proc.stdin.flush();
      },
      output: proc.stdout,
      destroy: () => this.kill(),
      diagnostics: () => this.stderrTail.trim(),
    };
    this.connection = new PipeConnection(transport, { timeoutMs: options.callTimeoutMs ?? 30_000, maxSegmentBytes: options.maxSegmentBytes });
  }

  /** Keep reading standard error so a chatty worker never blocks on a full pipe; remember the tail. */
  private async drainStderr(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.process.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // The pipe closes when the worker dies; nothing more to read.
    }
  }

  call(request: ReactorPipeRequest, segments: readonly Uint8Array[] = []): Promise<PipeResult> {
    return this.connection.call(request, segments);
  }

  discard(): void {
    this.discarded = true;
  }

  get usable(): boolean {
    return !this.exited && !this.discarded && !this.connection.broken;
  }

  kill(): void {
    try {
      this.process.kill();
    } catch {
      // Already gone.
    }
  }

  /** Kill the process and wait for it to be reaped. */
  async stop(): Promise<void> {
    this.connection.break("worker stopped");
    this.kill();
    await this.process.exited;
  }
}

export class WorkerPool {
  private readonly options: WorkerPoolOptions;
  private readonly size: number;
  private readonly idle: Worker[] = [];
  private readonly all = new Set<Worker>();
  private readonly waiters: Array<(worker: Worker | null) => void> = [];
  private leased = 0;
  private closed = false;
  private spawnedCount = 0;

  constructor(options: WorkerPoolOptions) {
    if (options.command.length === 0) throw new RangeError("worker command is empty");
    this.options = options;
    this.size = options.size ?? 2;
    if (!Number.isInteger(this.size) || this.size < 1) throw new RangeError("pool size must be a positive integer");
  }

  /** How many processes this pool has started so far (a crashed worker's replacement counts). */
  get spawned(): number {
    return this.spawnedCount;
  }

  /** Run `job` with a worker to itself. The worker goes back to the pool when the job returns, unless it
   * faulted or was discarded. A job that throws anything but an `EngineRefusal` loses its worker: it may
   * hold document handles nobody can account for. */
  async withWorker<T>(job: (worker: EngineWorker) => Promise<T>): Promise<T> {
    const worker = await this.lease();
    let keep = false;
    try {
      const result = await job(worker);
      keep = true;
      return result;
    } catch (e) {
      keep = e instanceof EngineRefusal;
      throw e;
    } finally {
      this.release(worker, keep);
    }
  }

  private async lease(): Promise<Worker> {
    if (this.closed) throw new EngineFault("worker pool is closed");
    if (this.leased >= this.size) {
      const slot = Promise.withResolvers<Worker | null>();
      this.waiters.push(slot.resolve);
      const woken = await slot.promise;
      if (this.closed) throw new EngineFault("worker pool is closed");
      // A released slot is handed over directly, so the lease count already includes this caller.
      return woken ?? this.start();
    }
    this.leased++;
    return this.take();
  }

  /** An idle worker that is still usable, or a new one. */
  private take(): Worker {
    for (let w = this.idle.pop(); w !== undefined; w = this.idle.pop()) {
      if (w.usable) return w;
      this.retire(w);
    }
    return this.start();
  }

  private start(): Worker {
    try {
      const worker = new Worker(this.options);
      this.all.add(worker);
      this.spawnedCount++;
      return worker;
    } catch (e) {
      this.leased--;
      throw new EngineFault(`cannot start worker ${JSON.stringify(this.options.command)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private retire(worker: Worker): void {
    this.all.delete(worker);
    worker.kill();
  }

  private release(worker: Worker, keep: boolean): void {
    const reusable = keep && worker.usable && !this.closed;
    if (!reusable) this.retire(worker);
    const next = this.waiters.shift();
    if (next) {
      // The slot passes to the next waiter; a reusable worker passes with it.
      next(reusable ? worker : null);
      return;
    }
    this.leased--;
    if (reusable) this.idle.push(worker);
  }

  /** Stop every worker. Jobs waiting for a worker fail. */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    const workers = [...this.all];
    this.all.clear();
    this.idle.length = 0;
    await Promise.all(workers.map((w) => w.stop()));
  }
}
