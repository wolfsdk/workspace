// The rules the engine checks report by, tested without an engine module: a module that lacks a command
// makes a check SKIPPED naming that command (never a pass), a failed assertion is a failure with its
// message, and a passed check keeps the parts it skipped.
import { describe, expect, test } from "bun:test";
import { CheckFailure, Skipped, createAsserter, type Asserter, type EngineContext } from "./harness.ts";
import { executeCheck } from "./run.ts";

/** A context for a module that exports every command except `recalc`; its kernels are never used. */
const commands = ["version", "open", "close", "save", "observe", "apply", "extract", "damage_report"];
const ctx: EngineContext = {
  modulePath: "none",
  build: "wolf 0.0.0 (commit 0000000)",
  kernel() {
    throw new Error("no kernel in this test");
  },
  commands,
  has: (command) => commands.includes(command),
  require(command) {
    if (!commands.includes(command)) throw new Skipped(command, `the module does not export the "${command}" command`);
  },
  log() {},
};

describe("engine check results", () => {
  test("require passes for a command the module has and throws Skipped naming one it lacks", () => {
    expect(() => ctx.require("extract")).not.toThrow();
    let thrown: unknown;
    try {
      ctx.require("recalc");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Skipped);
    expect((thrown as Skipped).command).toBe("recalc");
  });

  test("a check that needs a missing command is skipped with its name, not passed", async () => {
    const result = await executeCheck(ctx, "review-actions", "xlsx", async (c) => {
      c.require("recalc");
      return { checks: 1 };
    });
    expect(result.status).toBe("skipped");
    expect(result.checks).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.command).toBe("recalc");
    expect(result.skipped[0]!.reason).toContain("recalc");
  });

  test("a failed assertion is a failed result carrying its message", async () => {
    const result = await executeCheck(ctx, "comparison", "docx", async () => {
      const ok: Asserter = createAsserter();
      ok(1 + 1 === 2, "arithmetic");
      ok(false, "the sha256 of the replay equals the submitted one");
      return { checks: ok.count };
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("FAIL: the sha256 of the replay equals the submitted one");
    expect(result.checks).toBe(0);
    expect(new CheckFailure("x").message).toBe("FAIL: x");
  });

  test("any other throw is a failed result naming the error", async () => {
    const result = await executeCheck(ctx, "parts-gate", "pptx", async () => {
      throw new TypeError("boom");
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("TypeError: boom");
  });

  test("a passed check keeps its counts, notes and the parts it skipped", async () => {
    const result = await executeCheck(ctx, "submission", "docx", async () => ({
      checks: 7,
      notes: ["one line"],
      skipped: [{ part: "demo-server", reason: "no server here" }],
      data: { rows: 1 },
    }));
    expect(result.status).toBe("passed");
    expect(result.checks).toBe(7);
    expect(result.notes).toEqual(["one line"]);
    expect(result.skipped).toEqual([{ part: "demo-server", reason: "no server here" }]);
    expect(result.data).toEqual({ rows: 1 });
  });
});
