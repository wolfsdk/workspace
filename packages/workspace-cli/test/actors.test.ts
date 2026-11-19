// The actors file that `serve` rereads: a token added is accepted on the next check, one removed is refused, and a
// file that is half written or invalid keeps the last good directory in force.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { watchActorDirectory } from "../src/actors.ts";

// Writes are flushed to disk: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const BOB: RoomActor = { kind: "user", id: "bob", name: "Bob" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-actors-"));
  file = join(dir, "actors.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Replace the actors file the way a host should: write a temporary file, then rename it over the original. */
async function replace(contents: unknown): Promise<void> {
  const temporary = join(dir, `actors.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, typeof contents === "string" ? contents : JSON.stringify(contents));
  await rename(temporary, file);
}

/** The actor `token` stands for in the directory in force now. */
function actorOf(watched: { current(): { actors: Map<string, RoomActor> } }, token: string): RoomActor | null {
  return watched.current().actors.get(token) ?? null;
}

describe("a watched actors file", () => {
  test("accepts a token added to the file on the next check", async () => {
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    await replace({ [tokenA]: ALICE });
    const log: string[] = [];
    const watched = await watchActorDirectory(file, (line) => log.push(line));
    expect(actorOf(watched, tokenA)).toEqual(ALICE);
    expect(actorOf(watched, tokenB)).toBeNull();

    await replace({ [tokenA]: ALICE, [tokenB]: BOB });
    expect(actorOf(watched, tokenB)).toEqual(BOB);
    expect(actorOf(watched, tokenA)).toEqual(ALICE);
    expect(log).toEqual([]);
  });

  test("refuses a token removed from the file on the next check", async () => {
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    await replace({ [tokenA]: ALICE, [tokenB]: BOB });
    const watched = await watchActorDirectory(file, () => {});
    expect(actorOf(watched, tokenB)).toEqual(BOB);

    await replace({ [tokenA]: ALICE });
    expect(actorOf(watched, tokenB)).toBeNull();
    expect(actorOf(watched, tokenA)).toEqual(ALICE);
  });

  test("follows an agent's operator as the file changes it", async () => {
    const tokenA = crypto.randomUUID();
    const tokenR = crypto.randomUUID();
    await replace({ [tokenA]: ALICE, [tokenR]: { ...ROBOT, operator: { id: "alice", name: "Alice" } } });
    const watched = await watchActorDirectory(file, () => {});
    expect(watched.current().operatorOf(ROBOT)).toEqual({ id: "alice", name: "Alice" });

    await replace({ [tokenA]: ALICE, [tokenR]: ROBOT });
    expect(watched.current().operatorOf(ROBOT)).toBeNull();
  });

  test("keeps the last good directory when the file is half written, invalid, empty or gone, and says so once", async () => {
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    await replace({ [tokenA]: ALICE });
    const log: string[] = [];
    const watched = await watchActorDirectory(file, (line) => log.push(line));
    const directory = watched.current();

    // Half written: a writer that rewrites the file in place and has not finished.
    const full = JSON.stringify({ [tokenA]: ALICE, [tokenB]: BOB });
    await writeFile(file, full.slice(0, full.length - 9));
    expect(watched.current()).toBe(directory);
    expect(actorOf(watched, tokenA)).toEqual(ALICE);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("keeping the 1 token read before");
    expect(log[0]).not.toContain("\n");

    // Looking again at the same bad file neither reads it again nor repeats the line.
    expect(watched.current()).toBe(directory);
    expect(watched.current()).toBe(directory);
    expect(log).toHaveLength(1);

    // Each of these is a file that does not describe who may connect.
    for (const bad of ["", "{", "[]", "{}", JSON.stringify({ [tokenB]: { kind: "root", id: "x", name: "X" } }), JSON.stringify({ [tokenB]: { kind: "user", id: "a b", name: "X" } })]) {
      await replace(bad);
      expect(watched.current()).toBe(directory);
      expect(actorOf(watched, tokenA)).toEqual(ALICE);
      expect(actorOf(watched, tokenB)).toBeNull();
    }
    expect(log).toHaveLength(7);

    // Gone: a writer that removed the file before it put the new one back.
    await rm(file);
    expect(watched.current()).toBe(directory);
    expect(log).toHaveLength(8);

    // The file comes back whole, and the new directory is in force from the next check.
    await replace(full);
    expect(actorOf(watched, tokenB)).toEqual(BOB);
    expect(actorOf(watched, tokenA)).toEqual(ALICE);
    expect(log).toHaveLength(8);
  });

  test("an in-place rewrite is seen too, by its size", async () => {
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    await replace({ [tokenA]: ALICE });
    const watched = await watchActorDirectory(file, () => {});
    await writeFile(file, JSON.stringify({ [tokenA]: ALICE, [tokenB]: BOB }));
    expect(actorOf(watched, tokenB)).toEqual(BOB);
  });

  test("a file that cannot be used at start is an error, not a directory", async () => {
    await replace("{");
    expect(await watchActorDirectory(file, () => {}).then(() => "watching", (e: unknown) => (e instanceof Error ? e.name : "?"))).toBe("UsageError");
    expect(await watchActorDirectory(join(dir, "missing.json"), () => {}).then(() => "watching", (e: unknown) => (e instanceof Error ? e.name : "?"))).toBe("UsageError");
  });
});

describe("the guest scope of an actors file", () => {
  const DOCS = { docs: [{ room: "r1", doc: "brief.docx" }] };
  const GUEST = { kind: "user", id: "gail", name: "Gail", guest: DOCS };

  test("a guest user and an agent with a guest field are limited to their documents, and members to none", async () => {
    await replace({ ta: ALICE, tg: GUEST, tr: { ...ROBOT, guest: { docs: [{ room: "r2", doc: "plan.xlsx" }] } } });
    const { scopeOf } = (await watchActorDirectory(file, () => {})).current();
    expect(scopeOf(ALICE)).toBeNull();
    expect(scopeOf({ kind: "user", id: "gail", name: "Gail" })).toEqual({ access: "propose", docs: [{ room_id: "r1", doc_name: "brief.docx" }] });
    expect(scopeOf(ROBOT)).toEqual({ access: "propose", docs: [{ room_id: "r2", doc_name: "plan.xlsx" }] });
    expect(scopeOf({ kind: "user", id: "stranger", name: "S" })).toBeNull();
  });

  test("an agent of a guest inherits the scope, and an agent of a member does not", async () => {
    const mine = { kind: "agent", id: "gail-bot", name: "Gail Bot", operator: { id: "gail", name: "Gail" } };
    const hers = { kind: "agent", id: "alice-bot", name: "Alice Bot", operator: { id: "alice", name: "Alice" } };
    await replace({ ta: ALICE, tg: GUEST, t1: mine, t2: hers });
    const { scopeOf } = (await watchActorDirectory(file, () => {})).current();
    expect(scopeOf({ kind: "agent", id: "gail-bot", name: "Gail Bot" })).toEqual({ access: "propose", docs: [{ room_id: "r1", doc_name: "brief.docx" }] });
    expect(scopeOf({ kind: "agent", id: "alice-bot", name: "Alice Bot" })).toBeNull();
  });

  test("the scope follows a reload: a document added, and a guest made a member", async () => {
    await replace({ tg: GUEST });
    const watched = await watchActorDirectory(file, () => {});
    const gail: RoomActor = { kind: "user", id: "gail", name: "Gail" };
    await replace({ tg: { ...GUEST, guest: { docs: [...DOCS.docs, { room: "r1", doc: "two.docx" }] } } });
    expect(watched.current().scopeOf(gail)?.docs).toHaveLength(2);
    await replace({ tg: { kind: "user", id: "gail", name: "Gail" } });
    expect(watched.current().scopeOf(gail)).toBeNull();
  });

  test("refuses a guest field that is empty, too long, misshapen or has unknown keys, and keeps the last good directory", async () => {
    await replace({ ta: ALICE });
    const log: string[] = [];
    const watched = await watchActorDirectory(file, (line) => log.push(line));
    const directory = watched.current();
    const many = Array.from({ length: 51 }, (_, i) => ({ room: "r1", doc: `d${i}.docx` }));
    const bad: unknown[] = [
      { docs: [] },
      { docs: many },
      { docs: [{ room: "", doc: "a.docx" }] },
      { docs: [{ room: "r1", doc: 7 }] },
      { docs: [{ room: "r1", doc: "a.docx", extra: true }] },
      { docs: DOCS.docs, extra: true },
      { docs: "r1/a.docx" },
      [],
      null,
    ];
    for (const guest of bad) {
      await replace({ ta: ALICE, tg: { ...GUEST, guest } });
      expect(watched.current()).toBe(directory);
    }
    expect(log).toHaveLength(bad.length);
    await replace({ ta: ALICE, tg: { ...GUEST, guest: { docs: many.slice(0, 50) } } });
    expect(watched.current().scopeOf({ kind: "user", id: "gail", name: "Gail" })?.docs).toHaveLength(50);
  });
});
