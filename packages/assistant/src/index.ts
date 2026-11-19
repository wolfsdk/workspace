// `@wolfsdk/assistant`: one task of the Wolf Workspace assistant (`wolfsdk.assistant.v1`). A prompt layer over
// the eight workspace tools; the engine makes no model call.
export { chatCompletion, EndpointError, type AssistantEndpoint, type ChatCompletion, type ChatCompletionOptions, type ChatMessage, type ChatPart, type ChatTool, type ChatToolCall, type ChatUsage } from "./endpoint.ts";
export { ASSISTANT_DOC_FORMATS, assistantDocFormat, assistantInstructions, operationGuide, type AssistantDocFormat } from "./guide.ts";
export {
  ASSISTANT_CHAT_TOOLS,
  ASSISTANT_DEFAULT_LIMITS,
  ASSISTANT_TOOL_RESULT_MAX_CHARS,
  runAssistantTask,
  type AssistantLimits,
  type AssistantTask,
  type AssistantTaskOptions,
  type AssistantToolExecutor,
  type AssistantToolResult,
} from "./task.ts";
