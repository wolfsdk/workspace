// The commands, in process for check and refresh (their output and exit codes are the contract), and as a
// child process for the entry itself and for `serve`, which only a process can stop.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRoomDatabase, RoomStore } from "@wolfsdk/server";
import { binding, docx, manifest, manifestBytes, partText, QUARTERS, xlsx } from "../../packs/test/fixtures.ts";
import { makeHarness, seedRoom } from "../../server/test/fixtures/harness.ts";
import { loadActorDirectory, loadActors } from "../src/actors.ts";
import { EXIT_ERROR, EXIT_FRESH, EXIT_STALE, runCli, type CliIo } from "../src/run.ts";

// Writes are flushed to disk and processes are started: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const BINDINGS = [
  binding({ id: "table", target_kind: "docx_table", target_address: "Revenue", selector: { type: "range", sheet: "Fin", ref: "A1:B4" }, fit_policy: "grow" }),
  binding({ id: "headline", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" } }),
];

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const { io, out, err } = capture();
  const code = await runCli(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-workspace-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function writePack(bindings = BINDINGS): Promise<string> {
  const pack = join(dir, "pack");
  await Bun.$`mkdir -p ${pack}`.quiet();
  await writeFile(join(pack, "pack.wolf.json"), manifestBytes(manifest(bindings)));
  await writeFile(join(pack, "fin.xlsx"), xlsx({ rows: QUARTERS, names: { Headline: "Fin!$B$2" } }));
  await writeFile(join(pack, "deck.docx"), docx());
  return pack;
}

describe("check", () => {
  test("exits 1 on a stale pack, says which bindings, and writes nothing", async () => {
    const pack = await writePack();
    const before = await readFile(join(pack, "deck.docx"));
    const { code, out, err } = await run("check", pack);
    expect(code).toBe(EXIT_STALE);
    expect(err).toBe("");
    expect(out).toContain("stale");
    expect(out).toContain("table");
    expect(out).toContain("headline");
    expect(out).toContain(`pack quarterly: stale, 1 document would change`);
    expect(new Uint8Array(await readFile(join(pack, "deck.docx")))).toEqual(new Uint8Array(before));
  });

  test("prints the report as JSON", async () => {
    const pack = await writePack();
    const { code, out } = await run("check", pack, "--json");
    expect(code).toBe(EXIT_STALE);
    const report = JSON.parse(out);
    expect(report.pack_id).toBe("quarterly");
    expect(report.fresh).toBe(false);
    expect(report.bindings.map((b: { binding_id: string; status: string }) => [b.binding_id, b.status])).toEqual([["table", "stale"], ["headline", "stale"]]);
  });
});

describe("refresh", () => {
  test("writes the documents, then check exits 0, and a second refresh has nothing to do", async () => {
    const pack = await writePack();
    const first = await run("refresh", pack);
    expect(first.code).toBe(EXIT_FRESH);
    expect(first.out).toContain("pack quarterly: refreshed 1 document");
    expect(partText(new Uint8Array(await readFile(join(pack, "deck.docx"))), "word/document.xml")).toContain("$1,234,567.89");
    expect((await run("check", pack)).code).toBe(EXIT_FRESH);
    const second = await run("refresh", pack, "--json");
    expect(second.code).toBe(EXIT_FRESH);
    expect(JSON.parse(second.out)).toMatchObject({ pack_id: "quarterly", fresh: true, documents: [] });
    expect((await readdir(pack)).sort()).toEqual(["deck.docx", "fin.xlsx", "pack.wolf.json"]);
  });

  test("refuses the whole pack, exits 2, names each binding, and leaves the documents as they were", async () => {
    const pack = await writePack([
      ...BINDINGS,
      binding({ id: "gone", target_kind: "docx_bookmark", target_address: "Absent", selector: { type: "cell", sheet: "Fin", ref: "A1" } }),
    ]);
    const before = await readFile(join(pack, "deck.docx"));
    const human = await run("refresh", pack);
    expect(human.code).toBe(EXIT_ERROR);
    expect(human.err).toContain("pack-refused");
    expect(human.err).toContain("gone");
    const json = await run("refresh", pack, "--json");
    expect(json.code).toBe(EXIT_ERROR);
    expect(JSON.parse(json.out).error.problems.map((p: { binding_id: string; code: string }) => [p.binding_id, p.code])).toEqual([["gone", "address-unresolved"]]);
    expect(new Uint8Array(await readFile(join(pack, "deck.docx")))).toEqual(new Uint8Array(before));
  });

  test("exits 2 for a directory that is no pack", async () => {
    const { code, err } = await run("refresh", dir);
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain("manifest-missing");
  });

  test("an engine that cannot be started is an error, not a crash", async () => {
    const pack = await writePack();
    const { code, out } = await run("refresh", pack, "--engine", join(dir, "no-such-wolf"), "--json");
    expect(code).toBe(EXIT_ERROR);
    expect(JSON.parse(out).error.code).toBe("engine-failed");
  });
});

describe("usage", () => {
  test("names an unknown command, a missing option and an unknown flag, and exits 2 with the usage", async () => {
    for (const argv of [["frobnicate"], ["serve"], ["check", "--nope"], ["check", "a", "b"], []]) {
      const { code, err } = await run(...argv);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain("wolfsdk-workspace check");
    }
    expect((await run("serve")).err).toContain("serve needs --db, --blobs, --engine and --actors");
  });

  test("help is not an error", async () => {
    const { code, out } = await run("--help");
    expect(code).toBe(EXIT_FRESH);
    expect(out).toContain("wolfsdk-workspace serve");
  });
});

describe("seats", () => {
  const seeded = (): string => {
    const db = join(dir, "rooms.sqlite");
    const store = new RoomStore(db);
    store.addSeat({ kind: "user", id: "alice", name: "Alice", first_seen_at: "2026-11-13T10:00:00.000Z" });
    store.addSeat({ kind: "agent", id: "robot", name: "Robot", first_seen_at: "2026-11-13T10:00:01.000Z" });
    store.close();
    return db;
  };

  test("lists the seats, oldest first, as text and as JSON", async () => {
    const db = seeded();
    const text = await run("seats", "--db", db);
    expect(text.code).toBe(EXIT_FRESH);
    expect(text.out.split("\n")).toEqual([
      "user  alice  Alice  since 2026-11-13T10:00:00.000Z",
      "agent robot  Robot  since 2026-11-13T10:00:01.000Z",
      "2 seats taken",
    ]);
    const json = await run("seats", "--db", db, "--json");
    expect(JSON.parse(json.out).seats.map((s: { kind: string; id: string }) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "agent:robot"]);
  });

  test("release frees the seat of one identity, and exits 2 for one that holds none", async () => {
    const db = seeded();
    const freed = await run("seats", "release", "agent", "robot", "--db", db);
    expect(freed).toMatchObject({ code: EXIT_FRESH, out: "freed the seat of agent robot" });
    expect((await run("seats", "--db", db)).out).toContain("1 seat taken");
    const again = await run("seats", "release", "agent", "robot", "--db", db);
    expect(again.code).toBe(EXIT_ERROR);
    expect(again.err).toContain("agent robot holds no seat");
    // A user and an agent that share an id are two identities.
    expect((await run("seats", "release", "agent", "alice", "--db", db)).code).toBe(EXIT_ERROR);
    expect((await run("seats", "--db", db)).out).toContain("user  alice");
  });

  test("a database that is not there is an error, and none is created", async () => {
    const missing = join(dir, "typo.sqlite");
    const { code, err } = await run("seats", "--db", missing);
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain("no room database at");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a file that is no room database is an error, and is left as it was", async () => {
    const other = join(dir, "notes.txt");
    await writeFile(other, "not a database");
    const { code, err } = await run("seats", "--db", other);
    expect(code).toBe(EXIT_ERROR);
    expect(err).toContain("is not a room database");
    expect(await readFile(other, "utf8")).toBe("not a database");
    expect(await readdir(dir)).toEqual(["notes.txt"]);
  });

  test("exits 2 with the usage for a missing --db or a malformed release", async () => {
    const db = seeded();
    for (const argv of [["seats"], ["seats", "release", "--db", db], ["seats", "release", "robot", "--db", db], ["seats", "release", "group", "x", "--db", db], ["seats", "drop", "user", "alice", "--db", db]]) {
      const { code, err } = await run(...argv);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain("wolfsdk-workspace seats");
    }
    expect((await run("seats", "--db", db)).out).toContain("2 seats taken");
  });
});

describe("backup and restore", () => {
  test("are commands of the entry: a backup into a directory, its listing, a restore from it, and the usage names both", async () => {
    const h = await makeHarness();
    try {
      await seedRoom(h);
      const store = join(dir, "store");
      const made = await run("backup", "--db", join(h.dir, "rooms.sqlite"), "--blobs", join(h.dir, "blobs"), "--dir", store, "--keep", "2");
      expect(made.code).toBe(EXIT_FRESH);
      expect(made.err).toBe("");
      expect(made.out).toMatch(/^snapshot \S+ {2}\d+ bytes\n/);

      const listed = await run("restore", "--list", "--dir", store);
      const [id] = listed.out.split("\n");
      expect(listed.code).toBe(EXIT_FRESH);
      expect(listed.out).toBe(`${id}\n1 snapshot`);

      const db = join(dir, "copy", "rooms.sqlite");
      const restored = await run("restore", "--db", db, "--blobs", join(dir, "copy", "blobs"), "--dir", store);
      expect(restored.code).toBe(EXIT_FRESH);
      expect(restored.err).toBe("");
      expect(restored.out).toContain(`restored snapshot ${id}`);
      expect(isRoomDatabase(db)).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  test("a command without its flags exits 2 with the usage, which names both commands", async () => {
    for (const [argv, said] of [
      [["backup"], "backup needs --db, --blobs and --keep"],
      [["restore"], "restore needs --db and --blobs, or --list"],
    ] as const) {
      const { code, err } = await run(...argv);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain(said);
      expect(err).toContain("wolfsdk-workspace backup");
      expect(err).toContain("wolfsdk-workspace restore");
    }
    const { out } = await run("--help");
    expect(out).toContain("wolfsdk-workspace backup  --db <file> --blobs <dir> --keep <n>");
    expect(out).toContain("wolfsdk-workspace restore --list");
  });
});

describe("the actors file", () => {
  test("maps tokens to actors and refuses what is not one", async () => {
    const good = join(dir, "actors.json");
    await writeFile(
      good,
      JSON.stringify({
        t1: { kind: "user", id: "alice", name: "Alice" },
        t2: { kind: "agent", id: "robot", name: "Robot", operator: { id: "alice", name: "Alice" } },
        t3: { kind: "agent", id: "solo", name: "Solo" },
      }),
    );
    expect([...(await loadActors(good))]).toEqual([
      ["t1", { kind: "user", id: "alice", name: "Alice" }],
      ["t2", { kind: "agent", id: "robot", name: "Robot" }],
      ["t3", { kind: "agent", id: "solo", name: "Solo" }],
    ]);
    const dirLoaded = await loadActorDirectory(good);
    expect(dirLoaded.operatorOf({ kind: "agent", id: "robot", name: "Robot" })).toEqual({ id: "alice", name: "Alice" });
    expect(dirLoaded.operatorOf({ kind: "agent", id: "solo", name: "Solo" })).toBeNull();
    for (const [name, body] of [
      ["array.json", "[]"],
      ["empty.json", "{}"],
      ["not-json.json", "{"],
      ["kind.json", JSON.stringify({ t: { kind: "root", id: "x", name: "X" } })],
      ["id.json", JSON.stringify({ t: { kind: "user", id: "a b", name: "X" } })],
      ["name.json", JSON.stringify({ t: { kind: "user", id: "a", name: "" } })],
      ["user-op.json", JSON.stringify({ t: { kind: "user", id: "a", name: "A", operator: { id: "b", name: "B" } } })],
      ["bad-op.json", JSON.stringify({ t: { kind: "agent", id: "a", name: "A", operator: { id: "b b", name: "B" } } })],
      [
        "conflict-op.json",
        JSON.stringify({
          t1: { kind: "agent", id: "a", name: "A", operator: { id: "u1", name: "U1" } },
          t2: { kind: "agent", id: "a", name: "A", operator: { id: "u2", name: "U2" } },
        }),
      ],
    ] as const) {
      await writeFile(join(dir, name), body);
      expect(await loadActors(join(dir, name)).then(() => "loaded", (e: unknown) => (e instanceof Error ? e.name : "?"))).toBe("UsageError");
    }
    expect(await loadActors(join(dir, "missing.json")).then(() => "loaded", (e: unknown) => (e instanceof Error ? e.name : "?"))).toBe("UsageError");
  });
});

describe("the process", () => {
  test("the entry exits with the code of the command", async () => {
    const pack = await writePack();
    const stale = Bun.spawn([process.execPath, CLI, "check", pack], { stdout: "pipe", stderr: "pipe" });
    expect(await stale.exited).toBe(EXIT_STALE);
    expect(await new Response(stale.stdout).text()).toContain("stale");
    const bad = Bun.spawn([process.execPath, CLI, "nonsense"], { stdout: "pipe", stderr: "pipe" });
    expect(await bad.exited).toBe(EXIT_ERROR);
  });

  test("serve admits only a client with a token on one port for the UI, the API, the socket and MCP, and stops on a signal", async () => {
    const actors = join(dir, "actors.json");
    await writeFile(actors, JSON.stringify({ "token-a": { kind: "user", id: "alice", name: "Alice" } }));
    const ui = join(dir, "ui");
    await Bun.$`mkdir -p ${ui}`.quiet();
    await writeFile(join(ui, "index.html"), "<!doctype html><title>Wolf Workspace</title>");
    const serve = Bun.spawn(
      [
        process.execPath,
        CLI,
        "serve",
        "--db",
        join(dir, "rooms.sqlite"),
        "--blobs",
        join(dir, "blobs"),
        "--engine",
        join(dir, "no-such-wolf"),
        "--actors",
        actors,
        "--port",
        "0",
        "--static-dir",
        ui,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = serve.stdout.getReader();
      let seen = "";
      while (!seen.includes("mcp ")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`serve exited before it listened: ${await new Response(serve.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      const [listening = "", workspace = ""] = seen.trim().split("\n");
      const url = listening.replace(/^listening ws:/, "http:");
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ws$/);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      // Authenticated, but not a WebSocket upgrade: the server says so rather than letting it in.
      expect((await fetch(url, { headers: { authorization: "Bearer token-a" } })).status).toBe(426);
      expect((await fetch(`${url}?token=token-a`)).status).toBe(426);
      // The database has its server: a second one does not start, and the seats can still be read.
      const second = await run("serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", join(dir, "no-such-wolf"), "--actors", actors, "--port", "0");
      expect(second.code).toBe(EXIT_ERROR);
      expect(second.err).toContain("already served by another room server");
      expect(await run("seats", "--db", join(dir, "rooms.sqlite"))).toMatchObject({ code: EXIT_FRESH, out: "0 seats taken" });
      const origin = url.replace(/\/ws$/, "");
      expect(workspace).toBe(`workspace ${origin}`);
      expect(await (await fetch(`${origin}/`)).text()).toContain("Wolf Workspace");
      expect((await fetch(`${origin}/api/me`)).status).toBe(401);
      expect(await (await fetch(`${origin}/api/me?token=token-a`)).json()).toEqual({ actor: { kind: "user", id: "alice", name: "Alice" }, guest: null });
      expect((await fetch(`${origin}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
  });

  test("serve picks up a changed actors file without a restart, and keeps the last good one when the file is bad", async () => {
    const actors = join(dir, "actors.json");
    const alice = { kind: "user", id: "alice", name: "Alice" };
    const bob = { kind: "user", id: "bob", name: "Bob" };
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    /** The way a host replaces the file: a temporary file in the same folder, renamed over it. */
    const replace = async (contents: string): Promise<void> => {
      const temporary = join(dir, `actors.${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, contents);
      await rename(temporary, actors);
    };
    await replace(JSON.stringify({ [tokenA]: alice }));
    const serve = Bun.spawn(
      [process.execPath, CLI, "serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", join(dir, "no-such-wolf"), "--actors", actors, "--port", "0"],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = serve.stdout.getReader();
      let seen = "";
      while (!seen.includes("mcp ")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`serve exited before it listened: ${await new Response(serve.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      const origin = (seen.trim().split("\n")[0] ?? "").replace(/^listening ws:/, "http:").replace(/\/ws$/, "");
      const me = async (token: string): Promise<number> => (await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status;
      const mcp = async (token: string): Promise<number> => (await fetch(`${origin}/mcp`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${token}` } })).status;
      const socket = async (token: string): Promise<number> => (await fetch(`${origin}/ws`, { headers: { authorization: `Bearer ${token}` } })).status;
      expect([await me(tokenA), await me(tokenB)]).toEqual([200, 401]);

      // Added: accepted on the next request, over HTTP, MCP and the socket upgrade alike.
      await replace(JSON.stringify({ [tokenA]: alice, [tokenB]: bob }));
      expect([await me(tokenA), await me(tokenB)]).toEqual([200, 200]);
      expect(await mcp(tokenB)).not.toBe(401);
      expect(await socket(tokenB)).toBe(426);

      // Removed: refused on the next request.
      await replace(JSON.stringify({ [tokenB]: bob }));
      expect([await me(tokenA), await me(tokenB)]).toEqual([401, 200]);
      expect(await mcp(tokenA)).toBe(401);
      expect(await socket(tokenA)).toBe(401);

      // Half written, then not JSON: the directory of the last good file stays in force.
      await writeFile(actors, `{ "${tokenA}": { "kind": "us`);
      expect([await me(tokenA), await me(tokenB)]).toEqual([401, 200]);
      await replace("not json");
      expect([await me(tokenA), await me(tokenB)]).toEqual([401, 200]);

      // Whole again: read again.
      await replace(JSON.stringify({ [tokenA]: alice }));
      expect([await me(tokenA), await me(tokenB)]).toEqual([200, 401]);
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
    const stderr = await new Response(serve.stderr).text();
    expect(stderr.match(/actors file changed but cannot be used, keeping the 1 token read before/g)).toHaveLength(2);
  });

  test("serve refuses a directory that is not one and a room id that is not one", async () => {
    const actors = join(dir, "actors.json");
    await writeFile(actors, JSON.stringify({ "token-a": { kind: "user", id: "alice", name: "Alice" } }));
    const base = ["serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", "wolf", "--actors", actors];
    for (const [flag, value, message] of [
      ["--static-dir", join(dir, "nope"), "--static-dir"],
      ["--wasm-dir", join(dir, "nope"), "--wasm-dir"],
      ["--pack", join(dir, "nope"), "--pack"],
      ["--default-room", "bad id", "--default-room"],
      ["--workspace-id", "bad id", "--workspace-id"],
    ] as const) {
      const { code, err } = await run(...base, flag, value);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain(message);
    }
  });

  test("serve takes the plan flags together, and refuses a limit or a name that is none", async () => {
    const actors = join(dir, "actors.json");
    await writeFile(actors, JSON.stringify({ "token-a": { kind: "user", id: "alice", name: "Alice" } }));
    const base = ["serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", "wolf", "--actors", actors];
    const whole = ["--plan-seats", "1", "--plan-workspaces", "unlimited", "--plan-upgrade", "Move to Team."];
    for (const [flags, message] of [
      [["--plan-seats", "1"], "come together"],
      [["--plan-name", "free"], "come together"],
      [["--plan-seats", "1", "--plan-workspaces", "1"], "come together"],
      [["--plan-seats", "many", "--plan-workspaces", "1", "--plan-upgrade", "Move to Team."], "--plan-seats must be a whole number or unlimited"],
      [["--plan-seats=-1", "--plan-workspaces", "1", "--plan-upgrade", "Move to Team."], "--plan-seats must be a whole number or unlimited"],
      [["--plan-seats", "1", "--plan-workspaces", "1.5", "--plan-upgrade", "Move to Team."], "--plan-workspaces must be a whole number or unlimited"],
      [[...whole, "--plan-name", ""], "planCap: name is"],
    ] as const) {
      const { code, err } = await run(...base, ...flags);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain(message);
    }
  });

  test("serve takes the read-only flags together, and refuses a text that is blank or too long", async () => {
    const actors = join(dir, "actors.json");
    await writeFile(actors, JSON.stringify({ "token-a": { kind: "user", id: "alice", name: "Alice" } }));
    const base = ["serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", "wolf", "--actors", actors];
    for (const [flags, message] of [
      [["--read-only-reason", "The trial ended."], "--read-only-reason and --read-only-upgrade come together"],
      [["--read-only-upgrade", "https://cloud.example.test/upgrade"], "--read-only-reason and --read-only-upgrade come together"],
      [["--read-only-reason", " ", "--read-only-upgrade", "https://cloud.example.test/upgrade"], "--read-only-reason is 1 to 300 characters and not blank"],
      [["--read-only-reason", "The trial ended.", "--read-only-upgrade", ""], "--read-only-upgrade is 1 to 300 characters and not blank"],
      [["--read-only-reason", "x".repeat(301), "--read-only-upgrade", "https://cloud.example.test/upgrade"], "--read-only-reason is 1 to 300 characters and not blank"],
    ] as const) {
      const { code, err } = await run(...base, ...flags);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain(message);
    }
  });

  test("serve with the read-only flags reports why on /api/me and refuses a write with 402", async () => {
    const actors = join(dir, "actors.json");
    const alice = { kind: "user", id: "alice", name: "Alice" };
    const token = crypto.randomUUID();
    await writeFile(actors, JSON.stringify({ [token]: alice }));
    const reason = "The trial ended on 2026-11-28.";
    const upgrade = "https://cloud.example.test/upgrade";
    const serve = Bun.spawn(
      [
        process.execPath,
        CLI,
        "serve",
        "--db",
        join(dir, "rooms.sqlite"),
        "--blobs",
        join(dir, "blobs"),
        "--engine",
        join(dir, "no-such-wolf"),
        "--actors",
        actors,
        "--port",
        "0",
        "--read-only-reason",
        reason,
        "--read-only-upgrade",
        upgrade,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = serve.stdout.getReader();
      let seen = "";
      while (!seen.includes("mcp ")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`serve exited before it listened: ${await new Response(serve.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      const origin = (seen.trim().split("\n")[0] ?? "").replace(/^listening ws:/, "http:").replace(/\/ws$/, "");
      const headers = { authorization: `Bearer ${token}` };
      expect(await (await fetch(`${origin}/api/me`, { headers })).json()).toEqual({ actor: alice, guest: null, readOnly: { reason, upgrade } });
      expect((await fetch(`${origin}/api/rooms`, { headers })).status).toBe(200);
      const refused = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ room_id: "second" }) });
      expect(refused.status).toBe(402);
      expect(await refused.json()).toEqual({ error: { code: "LICENSE_LIMIT", message: `workspace-read-only: ${reason} ${upgrade}` } });
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
  });

  test("serve takes --share-connect as a path of its own host, names the scope of a guest, and answers a share link with no token", async () => {
    const actors = join(dir, "actors.json");
    await writeFile(
      actors,
      JSON.stringify({
        "token-a": { kind: "user", id: "alice", name: "Alice" },
        "token-g": { kind: "user", id: "gail", name: "Gail", guest: { docs: [{ room: "main", doc: "memo.docx" }] } },
      }),
    );
    const base = ["--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", join(dir, "no-such-wolf"), "--actors", actors, "--port", "0"];
    const bad = await run("serve", ...base, "--share-connect", "https://elsewhere.example.test/connect");
    expect(bad.code).toBe(EXIT_ERROR);
    expect(bad.err).toContain("--share-connect");
    const serve = Bun.spawn([process.execPath, CLI, "serve", ...base, "--share-connect", "/-/connect/instructions"], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = serve.stdout.getReader();
      let seen = "";
      while (!seen.includes("mcp ")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`serve exited before it listened: ${await new Response(serve.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      const origin = (seen.trim().split("\n")[0] ?? "").replace(/^listening ws:/, "http:").replace(/\/ws$/, "");
      const gail = { headers: { authorization: "Bearer token-g" } };
      expect(await (await fetch(`${origin}/api/me`, gail)).json()).toMatchObject({ guest: { docs: [{ room_id: "main", doc_name: "memo.docx" }] } });
      expect((await fetch(`${origin}/api/rooms`, { ...gail, method: "POST", headers: { ...gail.headers, "content-type": "application/json" }, body: JSON.stringify({ room_id: "mine" }) })).status).toBe(403);
      // The public route is there with no token, and says only that the link is not one.
      const unknown = await fetch(`${origin}/api/share/${"a".repeat(43)}`);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: "SHARE_NOT_FOUND" } });
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
  });
});
