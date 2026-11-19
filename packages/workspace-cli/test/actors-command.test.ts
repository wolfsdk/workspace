// `actors add` puts a person or an agent into the actors file of `serve` under a token it makes and prints once, and
// `serve` on an actors file that is not there makes one with one user and says where to sign in.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActorDirectory } from "../src/actors.ts";
import { EXIT_ERROR, EXIT_FRESH, runCli } from "../src/run.ts";

// `serve` runs as a child process: on a busy host it can take many seconds to listen.
setDefaultTimeout(120_000);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The token that `actors add` printed: 64 hex digits, printed exactly once. */
function printedToken(out: string): string {
  const tokens = out.match(/[0-9a-f]{64}/g) ?? [];
  expect(tokens).toHaveLength(1);
  return tokens[0] as string;
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-actors-"));
  file = join(dir, "actors.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("actors add", () => {
  test("makes a missing file with the user, mode 600, and prints the new token once", async () => {
    const { code, out, err } = await run("actors", "add", "user", "alice", "--name", "Alice", "--actors", file);
    expect([code, err]).toEqual([EXIT_FRESH, ""]);
    expect(out).toContain(`created ${file}: user alice (Alice)`);
    const token = printedToken(out);
    expect(out).toContain(`/?token=${token}`);
    expect(await mode(file)).toBe(0o600);
    const directory = await loadActorDirectory(file);
    expect([...directory.actors]).toEqual([[token, { kind: "user", id: "alice", name: "Alice" }]]);
  });

  test("adds to a file that has actors, keeps them, leaves the file mode 600 and gives each its own token", async () => {
    await writeFile(file, JSON.stringify({ "token-of-alice": { kind: "user", id: "alice", name: "Alice" } }));
    await chmod(file, 0o644);
    const bob = await run("actors", "add", "user", "bob", "--actors", file);
    expect(bob.code).toBe(EXIT_FRESH);
    expect(bob.out).toContain(`added to ${file}: user bob (bob)`);
    expect(await mode(file)).toBe(0o600);
    const carol = await run("actors", "add", "user", "carol", "--name", "Carol", "--actors", file, "--json");
    expect(carol.code).toBe(EXIT_FRESH);
    const report = JSON.parse(carol.out);
    expect(report).toMatchObject({ added: { kind: "user", id: "carol", name: "Carol", operator: null }, actors: file, created: false });
    expect(await mode(file)).toBe(0o600);
    const actors = (await loadActorDirectory(file)).actors;
    expect(actors.get("token-of-alice")).toEqual({ kind: "user", id: "alice", name: "Alice" });
    expect(actors.get(printedToken(bob.out))).toEqual({ kind: "user", id: "bob", name: "bob" });
    expect(actors.get(report.token)).toEqual({ kind: "user", id: "carol", name: "Carol" });
    expect(new Set([printedToken(bob.out), report.token]).size).toBe(2);
  });

  test("adds an agent on the seat of a user of the file, and refuses an operator that is not one", async () => {
    await run("actors", "add", "user", "alice", "--name", "Alice", "--actors", file);
    const robot = await run("actors", "add", "agent", "robot", "--name", "Robot", "--operator", "alice", "--actors", file);
    expect(robot.code).toBe(EXIT_FRESH);
    expect(robot.out).toContain("agent robot (Robot), on the seat of user alice");
    const token = printedToken(robot.out);
    expect(robot.out).toContain("Authorization: Bearer <token>");
    const directory = await loadActorDirectory(file);
    const agent = directory.actors.get(token);
    expect(agent).toEqual({ kind: "agent", id: "robot", name: "Robot" });
    expect(directory.operatorOf(agent!)).toEqual({ id: "alice", name: "Alice" });

    // An agent of its own seat, without an operator.
    const solo = await run("actors", "add", "agent", "solo", "--actors", file);
    expect(solo.code).toBe(EXIT_FRESH);
    expect((await loadActorDirectory(file)).operatorOf({ kind: "agent", id: "solo", name: "solo" })).toBeNull();

    const before = await readFile(file, "utf8");
    const nobody = await run("actors", "add", "agent", "ghost", "--operator", "mallory", "--actors", file);
    expect(nobody.code).toBe(EXIT_ERROR);
    expect(nobody.err).toContain("has no user mallory");
    const user = await run("actors", "add", "user", "dave", "--operator", "alice", "--actors", file);
    expect(user.code).toBe(EXIT_ERROR);
    expect(user.err).toContain("only an agent has an operator");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("refuses an id the file already has for that kind and leaves the file as it was", async () => {
    await run("actors", "add", "user", "alice", "--actors", file);
    await run("actors", "add", "agent", "robot", "--operator", "alice", "--actors", file);
    const before = await readFile(file, "utf8");
    for (const [kind, id] of [["user", "alice"], ["agent", "robot"]]) {
      const again = await run("actors", "add", kind as string, id as string, "--actors", file);
      expect(again.code).toBe(EXIT_ERROR);
      expect(again.err).toBe(`error: ${file} already has ${kind} ${id}; choose another id`);
      expect(again.out).toBe("");
    }
    expect(await readFile(file, "utf8")).toBe(before);
    // A user and an agent are different identities: the same id of the other kind is a new actor.
    expect((await run("actors", "add", "agent", "alice", "--actors", file)).code).toBe(EXIT_FRESH);
  });

  test("refuses a file serve would refuse, a bad id and a bad command line, and writes nothing", async () => {
    await writeFile(file, "not json");
    const broken = await run("actors", "add", "user", "alice", "--actors", file);
    expect(broken.code).toBe(EXIT_ERROR);
    expect(broken.err).toContain(`cannot read the actors file ${file}`);
    expect(await readFile(file, "utf8")).toBe("not json");

    const fresh = join(dir, "fresh.json");
    for (const argv of [
      ["actors", "add", "user", "no spaces", "--actors", fresh],
      ["actors", "add", "user", "alice", "--name", " ", "--actors", fresh],
      ["actors", "add", "robot", "alice", "--actors", fresh],
      ["actors", "add", "user", "alice"],
      ["actors", "remove", "user", "alice", "--actors", fresh],
    ]) {
      const { code, err } = await run(...argv);
      expect(code).toBe(EXIT_ERROR);
      expect(err).toContain("wolfsdk-workspace actors  add <user|agent> <id> --actors <file>");
    }
    expect(await Bun.file(fresh).exists()).toBe(false);
  });

  test("through a symbolic link, replaces the file it points at and keeps the link", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, JSON.stringify({ "token-of-alice": { kind: "user", id: "alice", name: "Alice" } }));
    await symlink(real, file);
    const { code, out } = await run("actors", "add", "user", "bob", "--actors", file);
    expect(code).toBe(EXIT_FRESH);
    expect((await loadActorDirectory(real)).actors.get(printedToken(out))).toEqual({ kind: "user", id: "bob", name: "bob" });
    expect((await stat(file)).ino).toBe((await stat(real)).ino);
  });
});

describe("serve on an actors file that is not there", () => {
  test("makes it with one user, prints where to sign in, and takes an actor added while it runs", async () => {
    const serve = Bun.spawn(
      [process.execPath, CLI, "serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", join(dir, "no-such-wolf"), "--actors", file, "--port", "0"],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = serve.stdout.getReader();
      let seen = "";
      while (!seen.includes("Add people and agents with:")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`serve exited before it listened: ${await new Response(serve.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      const token = seen.match(new RegExp(`^created ${file} with one user, owner; token ([0-9a-f]{64})$`, "m"))?.[1];
      expect(token).toBeDefined();
      const signIn = seen.match(/^Sign in at (http:\/\/\S+)\/\?token=([0-9a-f]{64})$/m);
      expect(signIn?.[2]).toBe(token);
      expect(seen).toContain(`Add people and agents with: wolfsdk-workspace actors add <user|agent> <id> --actors ${file}`);
      expect(await mode(file)).toBe(0o600);
      expect([...(await loadActorDirectory(file)).actors]).toEqual([[token!, { kind: "user", id: "owner", name: "Owner" }]]);

      const origin = signIn?.[1] as string;
      const me = async (bearer: string): Promise<number> => (await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${bearer}` } })).status;
      expect(await me(token!)).toBe(200);
      const bob = await run("actors", "add", "user", "bob", "--actors", file);
      expect(await me(printedToken(bob.out))).toBe(200);
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
  });

  test("a second start finds the file and makes no other user", async () => {
    await run("actors", "add", "user", "alice", "--actors", file);
    const before = await readFile(file, "utf8");
    const serve = Bun.spawn(
      [process.execPath, CLI, "serve", "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--engine", join(dir, "no-such-wolf"), "--actors", file, "--port", "0"],
      { stdout: "pipe", stderr: "pipe" },
    );
    let seen = "";
    try {
      const reader = serve.stdout.getReader();
      while (!seen.includes("mcp ")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`serve exited before it listened: ${await new Response(serve.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      // One answered request: the server is past its start, signal handlers included.
      const origin = (seen.trim().split("\n")[0] ?? "").replace(/^listening ws:/, "http:").replace(/\/ws$/, "");
      expect((await fetch(`${origin}/api/health`)).status).toBe(200);
    } finally {
      serve.kill("SIGTERM");
    }
    expect(await serve.exited).toBe(EXIT_FRESH);
    expect(seen).not.toContain("created");
    expect(seen).not.toContain("Sign in at");
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
