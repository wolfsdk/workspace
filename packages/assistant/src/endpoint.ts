// One call of an OpenAI-compatible chat-completions endpoint. The endpoint is a URL, a model name and a key
// the caller passes in: there is no provider SDK and no default. The call asks for a stream and reads either
// answer, a stream of `data:` chunks or one JSON completion.

/** Where the model is: the full chat-completions URL, the model name, and the key sent as a bearer token. */
export type AssistantEndpoint = { url: string; model: string; key: string };

export type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ChatTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };

/** Tokens of one call. `cached_tokens` is the part of `prompt_tokens` served from the provider's prompt cache,
 * never more than it. All zero when the endpoint reported no usage. */
export type ChatUsage = { prompt_tokens: number; cached_tokens: number; completion_tokens: number };
export type ChatCompletion = { content: string; tool_calls: ChatToolCall[]; usage: ChatUsage };

/** The endpoint did not give a completion: it was unreachable, answered with an error status, or answered with
 * something that is not a completion. The message never holds the key. */
export class EndpointError extends Error {
  override readonly name = "EndpointError";
}

export type ChatCompletionOptions = {
  endpoint: AssistantEndpoint;
  messages: readonly ChatMessage[];
  tools: readonly ChatTool[];
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** Each piece of answer text, as it arrives. */
  onText?: (delta: string) => void;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Usage as the endpoints report it: cached tokens under `prompt_tokens_details.cached_tokens` or
 * `prompt_cache_hit_tokens`. */
function usageOf(raw: unknown): ChatUsage {
  if (!isObject(raw)) return { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };
  const prompt = count(raw.prompt_tokens);
  const details = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const cached = count(details.cached_tokens) || count(raw.prompt_cache_hit_tokens);
  return { prompt_tokens: prompt, cached_tokens: Math.min(cached, prompt), completion_tokens: count(raw.completion_tokens) };
}

const errorOf = (raw: unknown): string | undefined =>
  isObject(raw) && isObject(raw.error) ? `the model endpoint reported an error: ${String(raw.error.message ?? raw.error.code ?? "unknown")}` : undefined;

/** Tool calls arrive in pieces keyed by `index`; this puts them together. */
class ToolCalls {
  readonly #calls: ChatToolCall[] = [];

  add(piece: unknown): void {
    if (!isObject(piece)) return;
    const index = typeof piece.index === "number" ? piece.index : this.#calls.length;
    const call = (this.#calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
    const fn = isObject(piece.function) ? piece.function : {};
    if (typeof piece.id === "string" && piece.id) call.id = piece.id;
    if (typeof fn.name === "string") call.function.name += fn.name;
    if (typeof fn.arguments === "string") call.function.arguments += fn.arguments;
  }

  /** The calls that name a tool, each with an id (an endpoint that sent none gets `call_<n>`). */
  list(): ChatToolCall[] {
    return this.#calls.filter((call) => call && call.function.name !== "").map((call, i) => (call.id === "" ? { ...call, id: `call_${i + 1}` } : call));
  }
}

async function readStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<ChatCompletion> {
  const calls = new ToolCalls();
  let content = "";
  let usage = usageOf(undefined);
  let chunks = 0;

  const chunk = (data: string): void => {
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new EndpointError("the model endpoint sent a chunk that is not JSON");
    }
    const failure = errorOf(parsed);
    if (failure) throw new EndpointError(failure);
    if (!isObject(parsed)) return;
    chunks += 1;
    if (parsed.usage != null) usage = usageOf(parsed.usage);
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    const delta = isObject(choice) && isObject(choice.delta) ? choice.delta : undefined;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content !== "") {
      content += delta.content;
      onText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) for (const piece of delta.tool_calls) calls.add(piece);
  };

  const decoder = new TextDecoder();
  let pending = "";
  const lines = (text: string): void => {
    pending += text;
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      if (line.startsWith("data:")) chunk(line.slice(5).trim());
    }
  };
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lines(decoder.decode(value, { stream: true }));
  }
  lines(`${decoder.decode()}\n`);

  if (chunks === 0) throw new EndpointError("the model endpoint answered without a completion");
  return { content, tool_calls: calls.list(), usage };
}

function readJson(parsed: unknown, onText: (delta: string) => void): ChatCompletion {
  const failure = errorOf(parsed);
  if (failure) throw new EndpointError(failure);
  const choice = isObject(parsed) && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const message = isObject(choice) && isObject(choice.message) ? choice.message : undefined;
  if (!isObject(parsed) || !message) throw new EndpointError("the model endpoint answered without a completion");
  const calls = new ToolCalls();
  if (Array.isArray(message.tool_calls)) message.tool_calls.forEach((call, index) => calls.add(isObject(call) ? { ...call, index } : call));
  const content = typeof message.content === "string" ? message.content : "";
  if (content !== "") onText(content);
  return { content, tool_calls: calls.list(), usage: usageOf(parsed.usage) };
}

async function call(options: ChatCompletionOptions): Promise<ChatCompletion> {
  const { endpoint, signal } = options;
  const onText = options.onText ?? (() => {});
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream, application/json", authorization: `Bearer ${endpoint.key}` },
    body: JSON.stringify({ model: endpoint.model, messages: options.messages, tools: options.tools, stream: true, stream_options: { include_usage: true } }),
  };
  if (signal) init.signal = signal;

  let response: Response;
  try {
    response = await options.fetch(endpoint.url, init);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new EndpointError("the model endpoint could not be reached");
  }
  if (!response.ok) throw new EndpointError(`the model endpoint answered ${response.status}`);

  try {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      if (!response.body) throw new EndpointError("the model endpoint answered without a completion");
      return await readStream(response.body, onText);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      throw new EndpointError("the model endpoint answered with something that is not JSON");
    }
    return readJson(parsed, onText);
  } catch (error) {
    if (error instanceof EndpointError || signal?.aborted) throw error;
    throw new EndpointError("the answer of the model endpoint broke off");
  }
}

/** Ask the endpoint for the next message of a conversation. Throws `EndpointError` when it gives none; a call
 * aborted through `signal` rejects as `fetch` does. */
export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletion> {
  try {
    return await call(options);
  } catch (error) {
    const key = options.endpoint.key;
    // A provider may quote the key it refused; what it said is kept, the key is not.
    if (error instanceof EndpointError && key !== "" && error.message.includes(key)) throw new EndpointError(error.message.split(key).join("[key]"));
    throw error;
  }
}
