// MCP over stdio: newline-delimited JSON-RPC 2.0, one message per line, on a pair of web streams (a process's
// stdin and stdout, or any other two ends). A client that sends `notifications/initialized` also gets the
// events of the room as `notifications/message`, because there is no second channel to ask for them on.
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { INTERNAL_ERROR, isObject, PARSE_ERROR, rpcError } from "./jsonrpc.ts";
import type { McpServer } from "./server.ts";

export type McpStdioOptions = {
  server: McpServer;
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  /** Overrides the server's agent for this connection. */
  actor?: RoomActor;
  /** Longest line accepted, in bytes. A longer one is answered with a parse error. Default 8 MiB. */
  maxLineBytes?: number;
};

const DEFAULT_MAX_LINE = 8 * 1024 * 1024;
const encoder = new TextEncoder();

/** Serve one client until `input` ends: every line is a message, every answer is a line. Resolves when the input
 * has ended and every call in flight has been answered. It does not close `output`. */
export async function runMcpStdioServer(options: McpStdioOptions): Promise<void> {
  const { server, input, output } = options;
  const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE;
  const session = server.createSession("stdio", options.actor ?? server.actor);
  const writer = output.getWriter();

  // Lines go out one at a time, in the order they were queued.
  let tail: Promise<void> = Promise.resolve();
  const send = (message: unknown): void => {
    const line = encoder.encode(`${JSON.stringify(message)}\n`);
    tail = tail.then(() => writer.write(line)).catch(() => undefined);
  };

  /** The room ended the stream because the agent holds no seat, or refused to start it for that reason: the
   * stream is attached again after a line, which may have taken a seat back. */
  let resume = false;
  const pending = new Set<Promise<void>>();
  // A line that follows `notifications/initialized` waits until the event stream is attached, so a call a client
  // sends right after it does not run before its events have somewhere to go. So does a line that follows one
  // after which the stream is attached again.
  let gate: Promise<void> = Promise.resolve();

  const attach = async (): Promise<void> => {
    if (session.streaming || session.closed) return;
    resume = false;
    const attached = await session.attach((message, _seq, last) => {
      send(message);
      if (last) resume = true;
    }, null);
    if (!attached.ok && attached.reason === "room" && attached.error.code === "LICENSE_LIMIT") resume = true;
  };

  const serve = async (body: unknown): Promise<void> => {
    const answer = await session.handleBody(body);
    if (answer !== undefined) send(answer);
  };

  const take = (line: string): void => {
    if (line.trim() === "") return;
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      send(rpcError(null, PARSE_ERROR, "the line is not JSON"));
      return;
    }
    const initialized = isObject(body) && body.method === "notifications/initialized" && !("id" in body);
    const attaches = initialized || resume;
    const job: Promise<void> = gate
      .then(() => serve(body))
      .then(attaches ? attach : () => undefined)
      .catch((error: unknown) => send(rpcError(null, INTERNAL_ERROR, error instanceof Error ? error.message : "internal error")))
      .finally(() => pending.delete(job));
    if (attaches) gate = job;
    pending.add(job);
  };

  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let skipping = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (skipping) skipping = false;
        else take(line);
        newline = buffer.indexOf("\n");
      }
      if (encoder.encode(buffer).length > maxLine) {
        // A line that never ends: refuse it now, and drop the rest of it when it does end.
        send(rpcError(null, PARSE_ERROR, `a line is over ${maxLine} bytes`));
        buffer = "";
        skipping = true;
      }
    }
    buffer += decoder.decode();
    if (!skipping) take(buffer);
    await Promise.all(pending);
  } finally {
    session.close();
    reader.releaseLock();
    await tail;
    writer.releaseLock();
  }
}
