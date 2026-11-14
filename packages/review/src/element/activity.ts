/** What a room agent is doing (the room contract's `RoomAgentActivity`; `idle` means it stopped). */
export type AgentActivity = "reading" | "searching" | "inspecting" | "proposing" | "committing" | "replying" | "idle";

/** One live agent: who it is, the document it works on (null: the room) and what it is doing. */
export type AgentPresence = {
  actor_id: string;
  display_name: string;
  doc_name: string | null;
  activity: AgentActivity;
  /** Free text shown as the pill's tooltip. */
  detail?: string;
};

/** The room contract's `agent.activity` server event, structurally (the test pins it to `RoomServerEvent`). */
export type RoomActivityEvent = {
  type: "agent.activity";
  seq: number;
  agent: { id: string; name: string };
  doc_name: string | null;
  activity: AgentActivity;
  detail?: string;
  at: string;
};

/** The agents after `event`: `idle` removes the agent, anything else adds it or replaces its entry in place. */
export function reduceAgentActivities(state: readonly AgentPresence[], event: RoomActivityEvent): AgentPresence[] {
  const id = event.agent.id;
  if (event.activity === "idle") return state.filter((agent) => agent.actor_id !== id);
  const next: AgentPresence = { actor_id: id, display_name: event.agent.name, doc_name: event.doc_name, activity: event.activity };
  if (event.detail !== undefined) next.detail = event.detail;
  if (id === "") return [...state];
  const at = state.findIndex((agent) => agent.actor_id === id);
  if (at < 0) return [...state, next];
  return state.map((agent, index) => (index === at ? next : agent));
}

/** The live agents of `input`: no `idle` and no empty id; one entry per id (the last wins, at the first one's place). */
export function normalizeAgentActivities(input: readonly AgentPresence[]): AgentPresence[] {
  const byId = new Map<string, AgentPresence>();
  for (const agent of input) if (agent.activity !== "idle" && agent.actor_id !== "") byId.set(agent.actor_id, { ...agent });
  return [...byId.values()];
}
