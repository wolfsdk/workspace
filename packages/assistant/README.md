# @wolfsdk/assistant

One task of the Wolf Workspace assistant (`wolfsdk.assistant.v1`): a person asks for a change in plain language, and a
model works on it through the eight tools of `wolfsdk.mcp-workspace.v1`. It is a prompt layer only. The engine makes no
model call, and the package depends on nothing outside this workspace.

```ts
import { runAssistantTask } from "@wolfsdk/assistant";

const turn = await runAssistantTask({
  endpoint: { url, model, key }, // an OpenAI-compatible chat-completions URL; no default, no provider SDK
  task: { task_id, conversation_id, room_id, workspace_id, user, assistant, request },
  history, // the earlier turns of the conversation
  execute: (call) => tools.call(assistant, call), // for example WorkspaceTools of @wolfsdk/mcp
  emit: (event) => send(event), // assistant.step, assistant.text, then assistant.task.finished
  started: () => count(), // right before the first model call
  signal, // abort to cancel
});
```

- The model gets the rules of the room, the operation guide of the open document's format (`operationGuide`), the
  earlier turns, the request, and the eight tool descriptors.
- Every tool call is checked against the tool's schema before it runs. A call that fails the check, and a call the room
  refuses, go back to the model as the tool's answer, so it can correct itself.
- The assistant never commits. `doc_edit` and `pack_link_refresh` run as `propose` whatever mode the model asked for,
  and only a person decides a proposal.
- A task ends as one turn record: `answered`, `proposed`, `cancelled`, `failed`, `turn_limit` (the model calls of
  `limits.maxModelCalls` are used up) or `token_limit` (the task has used `limits.maxTokens`). Its `usage` sums the
  prompt, cached and completion tokens of every model call.
- Page images of `doc_inspect_visual` are passed to the model only with `images: true`.
