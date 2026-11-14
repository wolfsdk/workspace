import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
/** The engine module of this checkout, built locally and git-ignored. */
const localEngine = join(workspaceRoot, "vendor/wolf_web.wasm");
const port = Number(process.env.PLAYGROUND_PORT ?? 5410);

/**
 * The review element as an embedder gets it: the built package. Its build
 * writes the element's CSS into the bundle for the shadow root; the sources
 * alone carry a placeholder and would put that CSS in this page instead.
 */
const reviewDist = join(workspaceRoot, "packages/review/dist");

function reviewPackage(): Plugin {
  return {
    name: "wolf-playground-review-package",
    buildStart() {
      if (!existsSync(join(reviewDist, "auto.js"))) {
        this.error("packages/review/dist is missing: run `bun run build` in sdk/web first");
      }
    },
  };
}

/** Must match `PYODIDE_VERSION` in `src/rivals/plan.ts` and the exact `pyodide` pin in package.json. */
const PYODIDE_VERSION = "0.29.5";
const PYODIDE_DIR = `pyodide/${PYODIDE_VERSION}/`;

/** The Pyodide package files the app serves: the two scripts the rivals worker
 * imports, and the runtime files the page fetches and checks by sha256. */
const PYODIDE_FILES: Record<string, string> = {
  "pyodide.mjs": "text/javascript",
  "pyodide.asm.js": "text/javascript",
  "pyodide.asm.wasm": "application/wasm",
  "python_stdlib.zip": "application/zip",
  "pyodide-lock.json": "application/json",
};

function pyodideRoot(): string {
  const root = dirname(createRequire(import.meta.url).resolve("pyodide"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  if (pkg.version !== PYODIDE_VERSION) {
    throw new Error(`pyodide ${pkg.version ?? "(unknown)"} is installed; the playground needs exactly ${PYODIDE_VERSION}`);
  }
  return root;
}

/**
 * - Serves the Pyodide files at `<base>pyodide/<version>/` in dev and copies
 *   them there in the build.
 * - In dev, serves this checkout's engine module at `<base>engine/wolf_web.wasm`
 *   when `vendor/wolf_web.wasm` exists, and tells the page so through
 *   `__LOCAL_ENGINE__`, which makes it the first engine choice.
 */
function playgroundFiles(): Plugin {
  let base = "/";
  let serve = false;
  return {
    name: "wolf-playground-files",
    config(_config, env) {
      serve = env.command === "serve";
      return { define: { __LOCAL_ENGINE__: JSON.stringify(serve && existsSync(localEngine)) } };
    },
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      const root = pyodideRoot();
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").replace(/[?#].*$/, "");
        let file: string | null = null;
        let type = "";
        if (path.startsWith(`${base}${PYODIDE_DIR}`)) {
          const name = path.slice(`${base}${PYODIDE_DIR}`.length);
          if (Object.hasOwn(PYODIDE_FILES, name)) {
            file = join(root, name);
            type = PYODIDE_FILES[name]!;
          }
        } else if (path === `${base}engine/wolf_web.wasm` && existsSync(localEngine)) {
          file = localEngine;
          type = "application/wasm";
        }
        if (!file) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", type);
        response.setHeader("Content-Length", String(statSync(file).size));
        response.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      if (serve) return;
      const root = pyodideRoot();
      for (const name of Object.keys(PYODIDE_FILES)) {
        this.emitFile({ type: "asset", fileName: `${PYODIDE_DIR}${name}`, source: readFileSync(join(root, name)) });
      }
    },
  };
}

export default defineConfig({
  base: process.env.PLAYGROUND_BASE ?? "/",
  plugins: [reviewPackage(), playgroundFiles()],
  resolve: {
    alias: [
      { find: /^@wolfsdk\/review$/, replacement: join(reviewDist, "wolf-review.js") },
      { find: /^@wolfsdk\/review\/(auto|react|protocol|seal)$/, replacement: join(reviewDist, "$1.js") },
    ],
  },
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: { port, strictPort: true, fs: { allow: [workspaceRoot] } },
  preview: { port, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022" },
});
