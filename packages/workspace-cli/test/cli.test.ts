// The commands, in process for check and refresh (their output and exit codes are the contract), and as a
// child process for the entry itself and for `serve`, which only a process can stop.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "@wolfsdk/server";
import { binding, docx, manifest, manifestBytes, partText, QUARTERS, xlsx } from "../../packs/test/fixtures.ts";
import { loadActorDirectory, loadActors } from "../src/actors.ts";
import { EXIT_ERROR, EXIT_FRESH, EXIT_STALE, runCli, type CliIo } from "../src/run.ts";

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
      expect(await (await fetch(`${origin}/api/me?token=token-a`)).json()).toEqual({ actor: { kind: "user", id: "alice", name: "Alice" } });
      expect((await fetch(`${origin}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
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
});
