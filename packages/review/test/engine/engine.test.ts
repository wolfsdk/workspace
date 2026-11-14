// `bun test` entry of the six engine-backed checks: one test per check and format, on the node reactor
// kernel against one engine module (`WOLF_WEB_WASM`, else `vendor/wolf_web.wasm` of the web workspace).
//
// - No module on disk: every test below is registered as skipped (bun lists them in its skip count) and
//   one line on stderr says why. A module is never needed for any other test of the workspace.
// - A check that needs a module command the module lacks reports SKIPPED naming the command (see
//   `scripts/engine-checks.ts`); here that fails the test, so a gate that pins a module cannot go green
//   without the check having run. `ENGINE_CHECKS_ALLOW_SKIPS=1` turns it into a warning.
// - Parts of a check that cannot run in this workspace (named in the check's `skipped` list) are printed
//   as warnings; the check itself still passed on what ran.
import { describe, expect, test } from "bun:test";
import { CHECK_IDS, FORMATS, createContext, resolveModulePath } from "./harness.ts";
import { runCheck } from "./run.ts";

/** One check can replay every batch of a recorded session several times; give it room. */
const TIMEOUT_MS = 30 * 60 * 1000;
const allowSkips = process.env.ENGINE_CHECKS_ALLOW_SKIPS === "1";

const modulePath = resolveModulePath();
if (!modulePath) console.error("engine checks skipped: no engine module (set WOLF_WEB_WASM or put one at vendor/wolf_web.wasm)");
const ctx = modulePath ? await createContext(modulePath) : null;

describe.skipIf(!ctx)("engine checks", () => {
  for (const id of CHECK_IDS) {
    for (const format of FORMATS) {
      test(
        `${id} ${format}`,
        async () => {
          const result = await runCheck(ctx!, id, format);
          expect(result.status === "failed" ? result.error : null).toBeNull();
          if (result.status === "skipped") {
            const what = result.skipped.map((s) => `${s.command ?? s.part}: ${s.reason}`).join("; ");
            if (!allowSkips) throw new Error(`SKIPPED ${id} ${format}: ${what}`);
            console.warn(`SKIPPED ${id} ${format}: ${what}`);
            return;
          }
          expect(result.checks).toBeGreaterThan(0);
          for (const part of result.skipped) console.warn(`skipped part of ${id} ${format}: ${part.part}: ${part.reason}`);
        },
        TIMEOUT_MS,
      );
    }
  }
});
