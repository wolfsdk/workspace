import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.WORKSPACE_APP_PORT ?? 5420);
/** `vite dev` sends the API, the room socket, the MCP endpoint and the engine channel to a running
 * `wolfsdk-workspace serve`. */
const server = process.env.WORKSPACE_SERVER ?? "http://127.0.0.1:8787";

/**
 * The review element as an embedder gets it: the built package. Its build
 * writes the element's CSS into the bundle for the shadow root; the sources
 * alone carry a placeholder and would put that CSS in this page instead.
 */
const reviewDist = join(workspaceRoot, "packages/review/dist");

function reviewPackage(): Plugin {
  return {
    name: "wolf-workspace-review-package",
    buildStart() {
      if (!existsSync(join(reviewDist, "auto.js"))) {
        this.error("packages/review/dist is missing: run `bun run build` in sdk/web first");
      }
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [reviewPackage()],
  resolve: {
    alias: [
      { find: /^@wolfsdk\/review$/, replacement: join(reviewDist, "wolf-review.js") },
      { find: /^@wolfsdk\/review\/(auto|react|protocol|seal)$/, replacement: join(reviewDist, "$1.js") },
    ],
  },
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: {
    port,
    strictPort: true,
    fs: { allow: [workspaceRoot] },
    proxy: {
      "/api": server,
      "/mcp": server,
      "/wasm": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
  preview: { port, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false },
});
