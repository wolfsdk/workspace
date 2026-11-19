import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceApi } from "../apps/workspace/src/lib/api.ts";

// Run from the repository root after building the UI. Use the released native engine.
const engine = process.env.WOLF_ENGINE;
if (!engine) throw new Error("Set WOLF_ENGINE to the path of a released wolf executable");
const dir = await mkdtemp(join(tmpdir(), "workspace-smoke-"));
const actors = join(dir, "actors.json");
const token = crypto.randomUUID();
await writeFile(actors, JSON.stringify({ [token]: { kind: "user", id: "tester", name: "Tester" } }), { mode: 0o600 });
const server = Bun.spawn([process.execPath, "packages/workspace-cli/src/cli.ts", "serve", "--host", "127.0.0.1", "--port", "0", "--pool", "1", "--engine", engine, "--db", join(dir, "rooms.sqlite"), "--blobs", join(dir, "blobs"), "--actors", actors], { stdout: "pipe", stderr: "inherit" });
const deadline = setTimeout(() => server.kill(), 60_000);
try {
  let output = "";
  const reader = server.stdout.getReader();
  while (!output.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Room server exited before listening");
    output += new TextDecoder().decode(value);
  }
  const match = /^listening ws:\/\/127\.0\.0\.1:(\d+)\/ws$/m.exec(output);
  assert(match, "Expected a loopback room endpoint");
  const origin = `http://127.0.0.1:${match[1]}`;
  const api = new WorkspaceApi(origin, token);
  const index = await fetch(origin);
  assert(index.ok && (await index.text()).includes("Wolf Workspace"), "Expected built workspace HTML");
  assert.equal((await api.me()).actor.id, "tester");
  await api.createRoom("smoke");
  const bytes = await Bun.file("fixtures/docx/tiny.docx").arrayBuffer();
  await api.upload("smoke", new File([bytes], "tiny.docx"));
  assert.equal((await api.snapshot("smoke", "tiny.docx")).length, 1, "Expected a one-page rendering");
  assert.deepEqual((await api.head("smoke", "tiny.docx")).bytes, new Uint8Array(bytes));
  console.log("DOCX uploaded, rendered and downloaded byte-identically");
} finally {
  clearTimeout(deadline);
  server.kill();
  await server.exited;
  await rm(dir, { recursive: true, force: true });
}
