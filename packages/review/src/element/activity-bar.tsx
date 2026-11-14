import type { VNode } from "preact";
import type { AgentActivity, AgentPresence } from "./activity.ts";

const LABELS: Readonly<Partial<Record<AgentActivity, string>>> = {
  reading: "is reading",
  searching: "is searching",
  inspecting: "is inspecting",
  proposing: "is proposing a change",
  committing: "is committing",
  replying: "is replying",
};

/** The presence bar: one pill per live agent, nothing when none is. */
export function AgentActivityBar({ agents }: { agents: readonly AgentPresence[] }): VNode<Record<string, unknown>> | null {
  if (agents.length === 0) return null;
  return (
    <div data-part="agent-activity" role="status" aria-live="polite">
      {agents.map((agent) => (
        <span key={agent.actor_id} data-part="agent-pill" data-activity={agent.activity} title={agent.detail}>
          {`${agent.display_name} ${LABELS[agent.activity] ?? "is active"}${agent.doc_name ? ` - ${agent.doc_name}` : ""}`}
        </span>
      ))}
    </div>
  );
}
