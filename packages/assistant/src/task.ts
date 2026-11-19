// One task of the assistant: the request goes to the model with the instructions and the eight tools of
// `wolfsdk.mcp-workspace.v1`; each tool call the model makes runs through the executor the caller passed in,
// and its result goes back to the model, until the model answers or a limit, a cancel or a failure ends the
// task. The task reports itself as `wolfsdk.assistant.v1` events and ends as one turn record.
import {
  ASSISTANT_CONTRACT,
  MCP_WORKSPACE_TOOL_NAMES,
  MCP_WORKSPACE_TOOLS,
  validateMcpToolCall,
  type AssistantAgent,
  type AssistantOutcome,
  type AssistantRequest,
  type AssistantServerEvent,
  type AssistantStep,
  type AssistantTurn,
  type AssistantUsage,
  type AssistantUser,
  type McpWorkspaceCall,
  type McpWorkspaceToolName,
} from "@wolfsdk/protocol/workspace";
import { chatCompletion, EndpointError, type AssistantEndpoint, type ChatCompletion, type ChatMessage, type ChatPart, type ChatTool, type ChatToolCall } from "./endpoint.ts";
import { assistantDocFormat, assistantInstructions } from "./guide.ts";

/** What a tool gave back, in the shape of an MCP tool result: text and images for the model, the same data as
 * an object, and `isError` for a refusal the model should read and act on. */
export type AssistantToolResult = {
  content: readonly ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent: Record<string, unknown>;
  isError?: true;
};

/** Runs one validated tool call in the room, as the assistant's agent actor. */
export type AssistantToolExecutor = (call: McpWorkspaceCall) => Promise<AssistantToolResult>;

/** `maxModelCalls`: the model calls one task may make. `maxTokens`: the prompt and completion tokens a task
 * may have used when it asks for another model call. */
export type AssistantLimits = { maxModelCalls: number; maxTokens: number };
export const ASSISTANT_DEFAULT_LIMITS: AssistantLimits = { maxModelCalls: 16, maxTokens: 300_000 };

/** The characters of one tool result the model is shown. */
export const ASSISTANT_TOOL_RESULT_MAX_CHARS = 60_000;

export type AssistantTask = {
  task_id: string;
  conversation_id: string;
  room_id: string;
  workspace_id: string;
  user: AssistantUser;
  assistant: AssistantAgent;
  request: AssistantRequest;
};

export type AssistantTaskOptions = {
  endpoint: AssistantEndpoint;
  task: AssistantTask;
  /** The earlier turns of the conversation, oldest first. */
  history?: readonly AssistantTurn[];
  execute: AssistantToolExecutor;
  /** Receives `assistant.step`, `assistant.text` and, last, `assistant.task.finished`. */
  emit: (event: AssistantServerEvent) => void;
  /** Called once, right before the first model call: the moment the task counts against an allowance. */
  started?: (startedAt: string) => void;
  limits?: Partial<AssistantLimits>;
  /** Abort to cancel the task. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** The current instant as an RFC 3339 UTC string. */
  now?: () => string;
  /** The model reads images: page images of `doc_inspect_visual` are passed on. Off by default. */
  images?: boolean;
};

/** The eight workspace tools as chat-completions function tools. */
export const ASSISTANT_CHAT_TOOLS: readonly ChatTool[] = MCP_WORKSPACE_TOOLS.map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
}));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const isToolName = (name: string): name is McpWorkspaceToolName => (MCP_WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function oneLine(text: string, fallback: string, limit = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return fallback;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const refusal = (code: string, message: string): string => JSON.stringify({ error: { code, message } });

function requestMessage(request: AssistantRequest): string {
  const context: string[] = [];
  if (request.doc_name !== null) context.push(`Open document: ${request.doc_name}`);
  if (request.target_address !== null) context.push(`Selection: ${request.target_address}`);
  return context.length === 0 ? request.text : `${request.text}\n\n${context.join("\n")}`;
}

function answerMessage(turn: AssistantTurn): string {
  const lines = [turn.answer === "" ? `(The task ended as ${turn.outcome} without an answer.)` : turn.answer];
  if (turn.proposal_ids.length > 0) lines.push(`(Proposals opened: ${turn.proposal_ids.join(", ")})`);
  return lines.join("\n");
}

/** The document a call names, for the step. */
function docOf(call: McpWorkspaceCall): string | null {
  const name = call.name === "doc_create" ? call.arguments.name : "doc" in call.arguments ? call.arguments.doc : undefined;
  return typeof name === "string" && name !== "" ? name : null;
}

/** What a call that worked did, in one line. */
function summaryOf(call: McpWorkspaceCall): string {
  switch (call.name) {
    case "workspace_list":
      return "listed the room";
    case "doc_read":
      return oneLine(`read ${call.arguments.doc}${call.arguments.view ? ` as ${call.arguments.view}` : ""}`, "read a document");
    case "doc_search":
      return oneLine(`searched for "${call.arguments.query}"`, "searched");
    case "doc_create":
      return oneLine(`created ${call.arguments.name}`, "created a document");
    case "doc_edit": {
      const ops = call.arguments.ops.length;
      return oneLine(`proposed ${ops} change${ops === 1 ? "" : "s"} to ${call.arguments.doc}`, "proposed a change");
    }
    case "doc_inspect_visual":
      return oneLine(`looked at ${call.arguments.doc}`, "looked at a document");
    case "pack_link_refresh":
      return oneLine(`proposed a refresh of ${call.arguments.pack}`, "proposed a refresh");
    case "comment_reply":
      return "replied to a comment";
  }
}

function failureOf(result: AssistantToolResult): string {
  const error = result.structuredContent.error;
  const message = isObject(error) && typeof error.message === "string" ? error.message : (result.content.find((block) => block.type === "text")?.text ?? "");
  return oneLine(`refused: ${message}`, "refused");
}

/** Run one task to its end. Never throws for what the model, the endpoint or a tool does: every ending is a
 * turn, which is also the `assistant.task.finished` event. At least one model call is always made. */
export async function runAssistantTask(options: AssistantTaskOptions): Promise<AssistantTurn> {
  const { endpoint, task, execute, emit, signal } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const limits = { ...ASSISTANT_DEFAULT_LIMITS, ...options.limits };
  const fetcher = options.fetch ?? fetch;

  const startedAt = now();
  const usage: AssistantUsage = { model_calls: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };
  const steps: AssistantStep[] = [];
  const proposals: string[] = [];
  let answer = "";

  const messages: ChatMessage[] = [{ role: "system", content: assistantInstructions(assistantDocFormat(task.request.doc_name)) }];
  for (const turn of options.history ?? []) {
    messages.push({ role: "user", content: requestMessage(turn.request) }, { role: "assistant", content: answerMessage(turn) });
  }
  messages.push({ role: "user", content: requestMessage(task.request) });

  const finish = (outcome: AssistantOutcome, failure: string | null = null): AssistantTurn => {
    const finishedAt = now();
    const turn: AssistantTurn = {
      contract: ASSISTANT_CONTRACT,
      task_id: task.task_id,
      conversation_id: task.conversation_id,
      room_id: task.room_id,
      workspace_id: task.workspace_id,
      user: task.user,
      assistant: task.assistant,
      request: task.request,
      outcome,
      answer,
      failure,
      steps,
      proposal_ids: proposals,
      model: endpoint.model,
      usage,
      started_at: startedAt,
      finished_at: Date.parse(finishedAt) < Date.parse(startedAt) ? startedAt : finishedAt,
    };
    emit({ type: "assistant.task.finished", task_id: task.task_id, turn });
    return turn;
  };

  const say = (delta: string): void => {
    answer += delta;
    emit({ type: "assistant.text", task_id: task.task_id, delta });
  };

  /** Run one tool call of the model. Returns what the model is told, and the images the tool drew. */
  const runTool = async (wanted: ChatToolCall): Promise<{ text: string; images: ChatPart[] }> => {
    const name = wanted.function.name;
    if (!isToolName(name)) return { text: refusal("BAD_REQUEST", `there is no tool ${name}; the tools are ${MCP_WORKSPACE_TOOL_NAMES.join(", ")}`), images: [] };

    const step = (rest: Omit<AssistantStep, "step" | "tool">): AssistantStep => ({ step: steps.length + 1, tool: name, ...rest });
    const end = (ended: AssistantStep, text: string, images: ChatPart[] = []): { text: string; images: ChatPart[] } => {
      steps.push(ended);
      emit({ type: "assistant.step", task_id: task.task_id, step: ended });
      return { text, images };
    };

    let args: unknown;
    try {
      args = JSON.parse(wanted.function.arguments === "" ? "{}" : wanted.function.arguments);
    } catch {
      args = undefined;
    }
    // The assistant never commits: whatever mode the model asked for, a change is a proposal.
    if (isObject(args) && (name === "doc_edit" || name === "pack_link_refresh")) args = { ...args, mode: "propose" };
    const problems = args === undefined ? ["$.arguments: not JSON"] : validateMcpToolCall({ name, arguments: args });
    const call = { name, arguments: args } as McpWorkspaceCall;
    const docName = problems.length === 0 ? docOf(call) : null;

    emit({ type: "assistant.step", task_id: task.task_id, step: step({ doc_name: docName, status: "running" }) });
    if (problems.length > 0) {
      return end(step({ doc_name: docName, status: "failed", summary: oneLine(`refused: ${problems[0]}`, "refused") }), refusal("BAD_REQUEST", problems.join("; ")));
    }

    let result: AssistantToolResult;
    try {
      result = await execute(call);
    } catch (error) {
      const message = oneLine(error instanceof Error ? error.message : String(error), "the tool failed");
      return end(step({ doc_name: docName, status: "failed", summary: oneLine(`failed: ${message}`, "failed") }), refusal("INTERNAL", message));
    }

    const texts = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    const drawn = result.content.flatMap((block) => (block.type === "image" ? [block] : []));
    let text = texts.join("\n");
    if (text.length > ASSISTANT_TOOL_RESULT_MAX_CHARS) text = `${text.slice(0, ASSISTANT_TOOL_RESULT_MAX_CHARS)}\n[cut: the result is longer than ${ASSISTANT_TOOL_RESULT_MAX_CHARS} characters; read a smaller part]`;
    const images: ChatPart[] = options.images ? drawn.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })) : [];
    if (drawn.length > 0 && !options.images) text += `\n[${drawn.length} page image${drawn.length === 1 ? "" : "s"} not shown: this model reads text, use doc_read]`;

    if (result.isError) return end(step({ doc_name: docName, status: "failed", summary: failureOf(result) }), text);

    const ended = step({ doc_name: docName, status: "ok", summary: summaryOf(call) });
    const opened = result.structuredContent.proposal_id;
    if (typeof opened === "string" && ID.test(opened) && !proposals.includes(opened)) {
      ended.proposal_id = opened;
      proposals.push(opened);
    }
    return end(ended, text, images);
  };

  for (;;) {
    if (usage.model_calls >= Math.max(1, limits.maxModelCalls)) return finish("turn_limit");
    if (usage.model_calls > 0 && usage.prompt_tokens + usage.completion_tokens >= limits.maxTokens) return finish("token_limit");
    if (usage.model_calls === 0) options.started?.(startedAt);
    else if (answer !== "" && !answer.endsWith("\n")) say("\n\n");

    usage.model_calls += 1;
    let completion: ChatCompletion;
    try {
      const request = { endpoint, messages, tools: ASSISTANT_CHAT_TOOLS, fetch: fetcher, onText: say };
      completion = await chatCompletion(signal ? { ...request, signal } : request);
    } catch (error) {
      if (signal?.aborted) return finish("cancelled");
      return finish("failed", error instanceof EndpointError ? error.message : "the model call failed");
    }
    usage.prompt_tokens += completion.usage.prompt_tokens;
    usage.cached_tokens += completion.usage.cached_tokens;
    usage.completion_tokens += completion.usage.completion_tokens;
    if (signal?.aborted) return finish("cancelled");

    if (completion.tool_calls.length === 0) {
      if (proposals.length > 0) return finish("proposed");
      return answer.trim() === "" ? finish("failed", "the model gave no answer") : finish("answered");
    }

    messages.push({ role: "assistant", content: completion.content === "" ? null : completion.content, tool_calls: completion.tool_calls });
    const images: ChatPart[] = [];
    for (const wanted of completion.tool_calls) {
      const outcome = await runTool(wanted);
      messages.push({ role: "tool", tool_call_id: wanted.id, content: outcome.text });
      images.push(...outcome.images);
      if (signal?.aborted) return finish("cancelled");
    }
    if (images.length > 0) messages.push({ role: "user", content: [{ type: "text", text: "The page images of the calls above:" }, ...images] });
  }
}
