// Seatless identities: the ones a host says never take a seat. A guest of a shared document is one, and the agent a
// guest connects is another. They work in a workspace that is at its cap, count toward no cap, and leave the seats
// of the members as they were.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { PoolEngine, RoomServer } from "../src/index.ts";
import { alice, bob, bytesOf, Collector, makePool, must, refusalOf, steppingClock } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

const carol: RoomActor = { kind: "user", id: "carol", name: "Carol" };
const guest: RoomActor = { kind: "user", id: "guest", name: "Guest" };
const guestBot: RoomActor = { kind: "agent", id: "guest-bot", name: "Guest Bot" };
const DOC = "doc.docx";

let dir: string | undefined;
let server: RoomServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A server with a plan of two seats. `seatless` names the seatless identities by id and can change while the server
 * runs; the agent `guest-bot` acts for `guest`. */
async function start(seatless: Set<string>): Promise<RoomServer> {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-seatless-"));
  let counter = 0;
  server = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new PoolEngine(makePool()),
    now: steppingClock(),
    newId: () => `id-${++counter}`,
    planCap: { maxSeats: 2, maxWorkspaces: null, name: "free", upgrade: "Upgrade to add seats." },
    seatless: (actor) => seatless.has(actor.id),
    operatorOf: (agent) => (agent.id === guestBot.id ? { id: guest.id, name: guest.name } : null),
  });
  return server;
}

const seatsOf = (s: RoomServer): string[] => s.listSeats().map((seat) => seat.id);

describe("a workspace at its cap", () => {
  test("serves a seatless user and the agent of a seatless operator, and still refuses one more member", async () => {
    const s = await start(new Set([guest.id]));
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("hello") }));
    must(await s.join("room", bob, null, () => {}));
    expect(refusalOf(await s.join("room", carol, null, () => {})).code).toBe("LICENSE_LIMIT");

    const seen = new Collector();
    must(await s.join("room", guest, null, seen.listener));
    must(await s.getRoom("room", guest));
    must(await s.postComment("room", guest, { thread_id: null, doc_name: DOC, target_address: "p1", body: "hi", mentions: [] }));
    const proposal = must(await s.edit("room", guestBot, { doc_name: DOC, base_revision: 0, mode: "propose", batch: { ops: [{ op: "append", text: "!" }] } }));
    expect(proposal.mode).toBe("propose");
    must(await s.reportActivity("room", guestBot, { doc_name: DOC, activity: "reading" }));

    expect(seatsOf(s)).toEqual(["alice", "bob"]);
    expect(refusalOf(await s.join("room", carol, null, () => {})).code).toBe("LICENSE_LIMIT");
    // The members keep working, and the guest's subscription is not ended when a member's seat is freed.
    must(await s.edit("room", alice, { doc_name: DOC, base_revision: 0, mode: "commit", batch: { ops: [{ op: "append", text: "?" }] } }));
    expect(s.releaseSeat("user", "bob")).toBe(true);
    must(await s.join("room", carol, null, () => {}));
    expect(seen.ofType("error")).toEqual([]);
    expect(seen.ofType("doc.committed").length).toBe(1);
  });

  test("lets a seatless user create a room without a seat", async () => {
    const s = await start(new Set([guest.id]));
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.join("room", bob, null, () => {}));
    must(await s.createRoom(guest, { room_id: "mine", workspace_id: "ws" }));
    expect(seatsOf(s)).toEqual(["alice", "bob"]);
  });

  test("frees the seat of an identity that became seatless, for the next member", async () => {
    const seatless = new Set<string>();
    const s = await start(seatless);
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    const bobSeen = new Collector();
    must(await s.join("room", bob, null, bobSeen.listener));
    expect(refusalOf(await s.join("room", carol, null, () => {})).code).toBe("LICENSE_LIMIT");

    seatless.add(bob.id);
    must(await s.getRoom("room", bob));
    expect(seatsOf(s)).toEqual(["alice"]);
    must(await s.join("room", carol, null, () => {}));
    expect(seatsOf(s)).toEqual(["alice", "carol"]);
    // The subscription Bob made as a member went by the seat that is gone, so it ends and says so.
    expect(bobSeen.ofType("error").map((e) => e.code)).toEqual(["LICENSE_LIMIT"]);
  });
});
