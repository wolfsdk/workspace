/**
 * Playground entry: wires the engine, the package verifier, the rival
 * libraries and the presentation helpers into the shell.
 */
import { DEFAULT_ENGINE_CHANNEL, ENGINE_MODULE_NAME, type EngineSource } from "@wolfsdk/runtime/loader";
import { render } from "preact";
import { AnatomyMap, ByteRibbon, createGeiger, Legend } from "./anatomy/index.ts";
import { CodeDrawer } from "./codegen/index.ts";
import { createLabEngine } from "./lab/engine.ts";
import { type LabVerifier, type ModeDeps, TID } from "./lab/index.ts";
import { wolfOpsFor } from "./lab/ops.ts";
import { comparePackages, readPackage, sha256Hex } from "./lab/verify.ts";
import { PLAYGROUND_MODES } from "./registry.ts";
import { createFetchedAssets, createRivals, SCRIPT_DIR } from "./rivals/index.ts";
import { PlaygroundShell } from "./shell/index.tsx";
import type { EngineChoice } from "./shell/logic.ts";
import "./styles/tokens.css";
import "./styles/shell.css";

const root = document.getElementById("app")!;
const base = new URL(import.meta.env.BASE_URL, location.href);

function engineChoices(): EngineChoice[] {
  const choices: EngineChoice[] = [];
  if (__LOCAL_ENGINE__) {
    choices.push({
      id: "checkout",
      label: "This checkout's module",
      source: { url: new URL(`engine/${ENGINE_MODULE_NAME}`, base).href },
    });
  }
  choices.push({ id: "release", label: "Latest release", source: { channel: DEFAULT_ENGINE_CHANNEL } });
  return choices;
}

function boot(): void {
  const verifier: LabVerifier = { readPackage, comparePackages, sha256Hex };
  // Pyodide's scripts load by URL from this app's own origin; everything else
  // the Python worker reads is fetched here and checked against its pinned sha256.
  const scriptBase = new URL(SCRIPT_DIR, base).href;
  const deps: ModeDeps = {
    verifier,
    rivals: createRivals({ assets: createFetchedAssets({ base: scriptBase, sha256Hex }), verifier, scriptBase }),
    AnatomyMap,
    ByteRibbon,
    Legend,
    CodeDrawer,
    geiger: createGeiger(),
    wolfOpsFor,
  };
  render(
    <PlaygroundShell
      modes={PLAYGROUND_MODES}
      deps={deps}
      engines={engineChoices()}
      createEngine={(source: EngineSource) => createLabEngine({ source, verifier })}
      initialMode="review"
    />,
    root,
  );
}

try {
  boot();
} catch (error) {
  // The shell never mounted: say why instead of leaving a blank page.
  const panel = document.createElement("pre");
  panel.dataset.testid = TID.errorPanel;
  panel.dataset.code = "boot-failed";
  panel.textContent = `Wolf Review Playground could not start: ${error instanceof Error ? error.message : String(error)}`;
  root.replaceChildren(panel);
}
