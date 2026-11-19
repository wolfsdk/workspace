// The cap a plan puts on the licence: the server admits the smaller of the licence limit and the plan limit. A
// refusal the plan caused has a code of its own (`plan-seat-limit`, `plan-workspace-limit`) and a message that names
// the limit, who or what would be one more, and the upgrade path. A refusal of the licence is unchanged.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { type DocumentEngine, type PlanCap, PoolEngine, RoomServer } from "../src/index.ts";
import { alice, bob, bytesOf, Collector, makePool, must, refusalOf, steppingClock } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

const user = (n: number): RoomActor => ({ kind: "user", id: `user-${n}`, name: `User ${n}` });
const UPGRADE = "Move the customer to the team plan to add seats.";

/** The limits of the licence the engine reports, as the test sets them: `null` is no limit. */
type Licence = { seats: number | null; workspaces: number | null };

let dir: string | undefined;
let server: RoomServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Start a server on the files of `dir` (created on the first call) whose licence says `licence` and whose plan is
 * `planCap`. Calling it again closes the running server and starts another on the same files: a restart. */
async function start(licence: Licence, planCap?: PlanCap): Promise<RoomServer> {
  await server?.close();
  dir ??= await mkdtemp(join(tmpdir(), "wolfsdk-plan-"));
  const real = new PoolEngine(makePool());
  const engine: DocumentEngine = {
    entitlement: async () => ({ ...(await real.entitlement()), max_seats: licence.seats, max_workspaces: licence.workspaces }),
    replay: (input) => real.replay(input),
    close: () => real.close(),
  };
  let counter = 0;
  server = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine,
    now: steppingClock(),
    newId: () => `id-${++counter}`,
    planCap,
  });
  return server;
}

const seatsOf = (s: RoomServer): string[] => s.listSeats().map((seat) => seat.id);
const doc = { name: "doc.docx", format: "docx", bytes: bytesOf("hello") } as const;

describe("a plan cap below the licence", () => {
  test("refuses the next seat with the code of the plan, the limit, the person and the upgrade path", async () => {
    const s = await start({ seats: 5, workspaces: 1 }, { maxSeats: 2, maxWorkspaces: null, name: "free", upgrade: UPGRADE });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.join("room", bob, null, () => {}));
    expect(seatsOf(s)).toEqual(["alice", "bob"]);

    const refusal = refusalOf(await s.addDocument("room", user(3), doc));
    expect(refusal.code).toBe("LICENSE_LIMIT");
    expect(refusal.code === "LICENSE_LIMIT" && refusal.reason).toBe("plan-seat-limit");
    expect(refusal.message).toBe(`plan-seat-limit: the free plan admits 2 seats; User 3 would take one more. ${UPGRADE}`);
    // Nothing the refused person asked for happened, and every other way in is refused the same way.
    expect(seatsOf(s)).toEqual(["alice", "bob"]);
    expect(must(await s.getRoom("room", alice)).documents).toEqual([]);
    const refusals = [
      refusalOf(await s.join("room", user(3), null, () => {})),
      refusalOf(await s.getRoom("room", user(3))),
      refusalOf(await s.createRoom(user(3), { room_id: "mine", workspace_id: "ws" })),
    ];
    for (const refused of refusals) expect(refused.message).toStartWith("plan-seat-limit: ");
    // Seats the plan admits are not touched: a holder keeps working, and a freed seat admits the next person.
    must(await s.addDocument("room", alice, doc));
    expect(s.releaseSeat("user", "bob")).toBe(true);
    must(await s.join("room", user(3), null, () => {}));
    expect(seatsOf(s)).toEqual(["alice", "user-3"]);
  });

  test("names one seat in the singular", async () => {
    const s = await start({ seats: 5, workspaces: 1 }, { maxSeats: 1, maxWorkspaces: null, name: "free", upgrade: UPGRADE });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    expect(refusalOf(await s.join("room", bob, null, () => {})).message).toContain("the free plan admits 1 seat; Bob would take one more.");
  });

  test("refuses the next workspace with the code of the plan, the limit, the workspace and the upgrade path", async () => {
    const s = await start({ seats: null, workspaces: null }, { maxSeats: null, maxWorkspaces: 1, name: "team", upgrade: "Ask for the enterprise plan." });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.createRoom(alice, { room_id: "room-2", workspace_id: "ws" }));

    const refusal = refusalOf(await s.createRoom(alice, { room_id: "room-3", workspace_id: "other" }));
    expect(refusal.code).toBe("LICENSE_LIMIT");
    expect(refusal.code === "LICENSE_LIMIT" && refusal.reason).toBe("plan-workspace-limit");
    expect(refusal.message).toBe("plan-workspace-limit: the team plan serves 1 workspace; other would be one more. Ask for the enterprise plan.");
    expect((await s.listRooms()).map((r) => r.room_id).sort()).toEqual(["room", "room-2"]);
  });

  test("a plan with no limit of its own, or with no name, adds nothing to the licence", async () => {
    const s = await start({ seats: 3, workspaces: 1 }, { maxSeats: null, maxWorkspaces: null, upgrade: UPGRADE });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    for (const n of [1, 2]) must(await s.join("room", user(n), null, () => {}));
    const refusal = refusalOf(await s.join("room", user(3), null, () => {}));
    expect(refusal.message).toBe("this licence admits 3 seats; User 3 would take one more");
    expect(refusal.code === "LICENSE_LIMIT" && refusal.reason).toBeUndefined();
  });

  test("the plan name defaults to current", async () => {
    const s = await start({ seats: 5, workspaces: 1 }, { maxSeats: 1, maxWorkspaces: null, upgrade: UPGRADE });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    expect(refusalOf(await s.join("room", bob, null, () => {})).message).toContain("the current plan admits 1 seat");
  });
});

describe("a licence limit that is the smaller stays a licence refusal", () => {
  test("a plan above the licence, and a plan equal to it", async () => {
    for (const planSeats of [4, 2]) {
      const s = await start({ seats: 2, workspaces: 1 }, { maxSeats: planSeats, maxWorkspaces: 1, name: "team", upgrade: UPGRADE });
      must(await s.createRoom(alice, { room_id: `room-${planSeats}`, workspace_id: "ws" }));
      must(await s.join(`room-${planSeats}`, bob, null, () => {}));
      const seat = refusalOf(await s.join(`room-${planSeats}`, user(3), null, () => {}));
      expect(seat.message).toBe("this licence admits 2 seats; User 3 would take one more");
      expect(seat.code === "LICENSE_LIMIT" && seat.reason).toBeUndefined();
      const workspace = refusalOf(await s.createRoom(alice, { room_id: `elsewhere-${planSeats}`, workspace_id: "other" }));
      expect(workspace.message).toBe("this licence serves 1 workspace; other would be one more");
      expect(workspace.code === "LICENSE_LIMIT" && workspace.reason).toBeUndefined();
      await rm(dir as string, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("each limit is compared on its own: the licence holds the seats back, the plan holds the workspaces back", async () => {
    const s = await start({ seats: 2, workspaces: 3 }, { maxSeats: 10, maxWorkspaces: 1, name: "free", upgrade: UPGRADE });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.join("room", bob, null, () => {}));
    expect(refusalOf(await s.join("room", user(3), null, () => {})).message).toStartWith("this licence admits 2 seats");
    expect(refusalOf(await s.createRoom(alice, { room_id: "other", workspace_id: "elsewhere" })).message).toStartWith("plan-workspace-limit: ");
  });
});

describe("a seat held before the cap was lowered", () => {
  test("follows the rule of the licence: the newest seats are freed, the oldest keep working", async () => {
    let s = await start({ seats: 5, workspaces: 1 });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    for (const n of [1, 2]) must(await s.join("room", user(n), null, () => {}));
    expect(seatsOf(s)).toEqual(["alice", "user-1", "user-2"]);

    s = await start({ seats: 5, workspaces: 1 }, { maxSeats: 2, maxWorkspaces: null, name: "free", upgrade: UPGRADE });
    must(await s.getRoom("room", alice));
    expect(seatsOf(s)).toEqual(["alice", "user-1"]);
    must(await s.getRoom("room", user(1)));
    const lost = refusalOf(await s.getRoom("room", user(2)));
    expect(lost.message).toStartWith("plan-seat-limit: the free plan admits 2 seats; User 2 would take one more.");
    // The identity that lost its seat takes one again as soon as one is free.
    expect(s.releaseSeat("user", "user-1")).toBe(true);
    must(await s.getRoom("room", user(2)));
    expect(seatsOf(s)).toEqual(["alice", "user-2"]);
  });
});

describe("with no plan cap", () => {
  test("only the licence limits: no limit of the licence is no limit at all", async () => {
    const s = await start({ seats: null, workspaces: null });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      must(await s.createRoom(user(n), { room_id: `room-${n}`, workspace_id: `ws-${n}` }));
    }
    expect(seatsOf(s)).toHaveLength(7);
  });

  test("a licence refusal is the one it always was", async () => {
    const s = await start({ seats: 2, workspaces: 1 });
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.join("room", bob, null, () => {}));
    const seat = refusalOf(await s.join("room", user(3), null, () => {}));
    expect(seat).toEqual({ code: "LICENSE_LIMIT", message: "this licence admits 2 seats; User 3 would take one more" });
    const workspace = refusalOf(await s.createRoom(alice, { room_id: "elsewhere", workspace_id: "other" }));
    expect(workspace).toEqual({ code: "LICENSE_LIMIT", message: "this licence serves 1 workspace; other would be one more" });
  });
});

describe("a plan cap that is wrong", () => {
  test.each([
    { maxSeats: -1, maxWorkspaces: null, upgrade: UPGRADE },
    { maxSeats: 2.5, maxWorkspaces: null, upgrade: UPGRADE },
    { maxSeats: null, maxWorkspaces: Number.NaN, upgrade: UPGRADE },
    { maxSeats: 1, maxWorkspaces: 1, upgrade: "" },
    { maxSeats: 1, maxWorkspaces: 1, upgrade: "x".repeat(301) },
    { maxSeats: 1, maxWorkspaces: 1, name: "", upgrade: UPGRADE },
    { maxSeats: 1, maxWorkspaces: 1, name: "n".repeat(65), upgrade: UPGRADE },
  ] satisfies PlanCap[])("is refused when the server is built: %p", async (cap) => {
    await expect(start({ seats: 5, workspaces: 1 }, cap)).rejects.toThrow("planCap");
  });
});
