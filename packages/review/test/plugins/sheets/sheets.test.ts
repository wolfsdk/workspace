import { expect, test } from "bun:test";

function run(script: string): void {
  const proc = Bun.spawnSync(["bun", new URL(script, import.meta.url).pathname], { stderr: "pipe", stdout: "pipe" });
  expect(proc.exitCode, proc.stdout.toString() + proc.stderr.toString()).toBe(0);
}

test("sheets refs-check", () => {
  run("./refs-check.mjs");
});

test("sheets adapter-check", () => {
  run("./adapter-check.mjs");
});
