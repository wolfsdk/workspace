// A reader of a Server-Sent Events response, frame by frame, with a deadline so a test that waits for a frame
// that never comes fails instead of hanging.
export type SseFrame = { id?: string; event?: string; data?: unknown; comment?: string };

export class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(response: Response) {
    if (response.body === null) throw new Error("the response has no body");
    this.#reader = response.body.getReader();
  }

  /** The next frame, or `null` when the stream ended. */
  async next(timeoutMs = 3000): Promise<SseFrame | null> {
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        return parse(block);
      }
      const { promise: deadline, reject } = Promise.withResolvers<never>();
      const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs} ms`)), timeoutMs);
      try {
        const { done, value } = await Promise.race([this.#reader.read(), deadline]);
        if (done) return null;
        this.#buffer += this.#decoder.decode(value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Frames until `match` accepts one; the frames it skipped come back too. Comments are skipped unless wanted. */
  async until(match: (frame: SseFrame) => boolean, timeoutMs = 3000): Promise<SseFrame[]> {
    const seen: SseFrame[] = [];
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === null) throw new Error(`the stream ended before the frame was seen; saw ${JSON.stringify(seen)}`);
      seen.push(frame);
      if (match(frame)) return seen;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

function parse(block: string): SseFrame {
  const frame: SseFrame = {};
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
    else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
    else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length > 0) frame.data = JSON.parse(data.join("\n"));
  return frame;
}

/** The notifications of `notifications/message` frames, with the event each carries. */
export function roomEvents(frames: readonly SseFrame[]): { level: string; event: Record<string, unknown>; id: string | undefined }[] {
  const out: { level: string; event: Record<string, unknown>; id: string | undefined }[] = [];
  for (const frame of frames) {
    const message = frame.data as { method?: string; params?: { level: string; logger: string; data: Record<string, unknown> } } | undefined;
    if (message?.method !== "notifications/message" || message.params === undefined) continue;
    out.push({ level: message.params.level, event: message.params.data, id: frame.id });
  }
  return out;
}
