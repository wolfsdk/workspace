import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VNode } from "preact";
import type { RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { AgentActivityBar } from "../../src/element/activity-bar.tsx";
import {
  normalizeAgentActivities,
  reduceAgentActivities,
  type AgentPresence,
  type RoomActivityEvent,
} from "../../src/element/activity.ts";

type ProtocolActivityEvent = Extract<RoomServerEvent, { type: "agent.activity" }>;

// The local event type and the room contract's must stay assignable both ways.
const fromProtocol = (event: ProtocolActivityEvent): RoomActivityEvent => event;
const toProtocol = (event: RoomActivityEvent): ProtocolActivityEvent => event;
void [fromProtocol, toProtocol];

function event(id: string, activity: RoomActivityEvent["activity"], extra: Partial<RoomActivityEvent> = {}): RoomActivityEvent {
  return { type: "agent.activity", seq: 1, agent: { id, name: `Agent ${id}` }, doc_name: null, activity, at: "2026-03-02T08:00:00Z", ...extra };
}

function presence(id: string, activity: AgentPresence["activity"] = "reading", extra: Partial<AgentPresence> = {}): AgentPresence {
  return { actor_id: id, display_name: `Agent ${id}`, doc_name: null, activity, ...extra };
}

type Vnode = VNode<Record<string, unknown>>;

const isVnode = (child: unknown): child is Vnode => typeof child === "object" && child !== null && "props" in child;

/** The vnode children of `node`. */
function childNodes(node: Vnode): Vnode[] {
  const { children } = node.props;
  return (Array.isArray(children) ? children : [children]).filter(isVnode);
}

/** The one pill of the bar for `agent`. */
function pillOf(agent: AgentPresence): Vnode {
  const [pill] = childNodes(barOf([agent]));
  if (!pill) throw new Error("expected a pill");
  return pill;
}

function barOf(agents: readonly AgentPresence[]): Vnode {
  const bar = AgentActivityBar({ agents });
  if (!bar) throw new Error("expected a bar");
  return bar;
}

describe("reduceAgentActivities", () => {
  test("a new agent is appended with the event's document and detail", () => {
    const next = reduceAgentActivities([], event("a", "reading", { doc_name: "q3.xlsx", detail: "Sheet1!A1:C9" }));
    expect(next).toEqual([{ actor_id: "a", display_name: "Agent a", doc_name: "q3.xlsx", activity: "reading", detail: "Sheet1!A1:C9" }]);
  });

  test("an event without detail leaves no detail member", () => {
    const [entry] = reduceAgentActivities([], event("a", "searching"));
    expect(entry && "detail" in entry).toBe(false);
  });

  test("a known agent is replaced in place, so the order is that of first appearance", () => {
    const state = [presence("a"), presence("b")];
    const next = reduceAgentActivities(state, event("a", "proposing", { doc_name: "deck.pptx" }));
    expect(next.map((agent) => [agent.actor_id, agent.activity, agent.doc_name])).toEqual([
      ["a", "proposing", "deck.pptx"],
      ["b", "reading", null],
    ]);
  });

  test("an upsert drops the previous detail", () => {
    const state = [presence("a", "reading", { detail: "old" })];
    expect(reduceAgentActivities(state, event("a", "replying"))[0]).toEqual(presence("a", "replying"));
  });

  test("idle removes that agent and only that agent", () => {
    const state = [presence("a"), presence("b"), presence("c")];
    expect(reduceAgentActivities(state, event("b", "idle")).map((agent) => agent.actor_id)).toEqual(["a", "c"]);
  });

  test("idle for an unknown agent changes nothing and the input is never mutated", () => {
    const state = [presence("a")];
    const next = reduceAgentActivities(state, event("zz", "idle"));
    expect(next).toEqual(state);
    expect(next).not.toBe(state);
    expect(state).toEqual([presence("a")]);
  });

  test("an event with an empty agent id is not tracked", () => {
    expect(reduceAgentActivities([presence("a")], event("", "reading")).map((agent) => agent.actor_id)).toEqual(["a"]);
  });
});

describe("normalizeAgentActivities", () => {
  test("idle entries and empty ids are dropped", () => {
    const out = normalizeAgentActivities([presence("a", "idle"), presence("", "reading"), presence("b", "committing")]);
    expect(out.map((agent) => agent.actor_id)).toEqual(["b"]);
  });

  test("duplicates keep the last entry at the first one's place", () => {
    const out = normalizeAgentActivities([presence("a", "reading"), presence("b"), presence("a", "replying", { doc_name: "x.docx" })]);
    expect(out.map((agent) => [agent.actor_id, agent.activity, agent.doc_name])).toEqual([
      ["a", "replying", "x.docx"],
      ["b", "reading", null],
    ]);
  });

  test("an idle last entry removes an earlier live one of the same id", () => {
    expect(normalizeAgentActivities([presence("a", "reading"), presence("a", "idle")])).toEqual([presence("a", "reading")]);
  });

  test("the result is a new array of new entries", () => {
    const input = [presence("a")];
    const out = normalizeAgentActivities(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
  });
});

describe("AgentActivityBar", () => {
  test("nothing when there are no agents", () => {
    expect(AgentActivityBar({ agents: [] })).toBeNull();
  });

  test("a status region with one pill per agent", () => {
    const bar = barOf([presence("a", "reading"), presence("b", "committing")]);
    expect(bar.type).toBe("div");
    expect(bar.props).toMatchObject({ "data-part": "agent-activity", role: "status", "aria-live": "polite" });
    const pills = childNodes(bar);
    expect(pills.map((pill) => pill.type)).toEqual(["span", "span"]);
    expect(pills.map((pill) => pill.props["data-part"])).toEqual(["agent-pill", "agent-pill"]);
    expect(pills.map((pill) => pill.props["data-activity"])).toEqual(["reading", "committing"]);
    expect(pills.map((pill) => pill.key)).toEqual(["a", "b"]);
  });

  test("each activity has its label", () => {
    const labels: [AgentPresence["activity"], string][] = [
      ["reading", "Agent a is reading"],
      ["searching", "Agent a is searching"],
      ["inspecting", "Agent a is inspecting"],
      ["proposing", "Agent a is proposing a change"],
      ["committing", "Agent a is committing"],
      ["replying", "Agent a is replying"],
    ];
    for (const [activity, text] of labels) expect(pillOf(presence("a", activity)).props.children).toBe(text);
  });

  test("the document name follows after a hyphen; the detail becomes the title", () => {
    const pill = pillOf(presence("a", "proposing", { doc_name: "q3.xlsx", detail: "Raise the forecast" }));
    expect(pill.props.children).toBe("Agent a is proposing a change - q3.xlsx");
    expect(pill.props.title).toBe("Raise the forecast");
  });

  test("a pill without detail has no title", () => {
    expect(pillOf(presence("a")).props.title).toBeUndefined();
  });

  test("a reduced event stream renders only the live agents: idle agents never render", () => {
    let agents: AgentPresence[] = [];
    for (const e of [event("a", "reading"), event("b", "searching"), event("a", "idle")]) agents = reduceAgentActivities(agents, e);
    expect(childNodes(barOf(agents)).map((pill) => pill.props["data-activity"])).toEqual(["searching"]);
    expect(AgentActivityBar({ agents: reduceAgentActivities(agents, event("b", "idle")) })).toBeNull();
  });
});

describe("element wiring", () => {
  // bun test has no DOM, so the element is checked by its source: the bar is the first child of the rendered tree.
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "element", "element.tsx"), "utf8");

  test("the bar is rendered before the editor into the mount", () => {
    expect(source.indexOf("<AgentActivityBar")).toBeGreaterThan(0);
    expect(source.indexOf("<AgentActivityBar")).toBeLessThan(source.indexOf("<EditorApp"));
    expect(source).toMatch(/<>\s*<AgentActivityBar agents=\{this\.#agents\} \/>\s*<EditorApp/);
  });

  test("the property, the method and the event are declared", () => {
    expect(source).toContain("get agentActivities()");
    expect(source).toContain("set agentActivities(");
    expect(source).toContain("applyRoomActivityEvent(event: RoomActivityEvent)");
    expect(source).toContain('this.#emit("wolf-review-agent-activity"');
  });

  test("the element styles the bar and the pill", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "src", "element", "styles.ts"), "utf8");
    expect(css).toContain('[data-part="agent-activity"]');
    expect(css).toContain('[data-part="agent-pill"]');
    expect(css).toContain("prefers-reduced-motion");
  });
});
