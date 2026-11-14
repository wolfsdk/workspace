import { defineConfig, type Plugin } from "vite";

const PLACEHOLDER = "__WOLF_REVIEW_CSS__";

/**
 * The shell and plugins import their CSS for its side effect. In library mode
 * Vite collects it into one asset (`wolf-review.css`) and injects nothing into
 * the page; this plugin writes that text into the JS in place of
 * `EDITOR_CSS` (src/element/styles.ts), so the element adopts it in its shadow root
 * without another request. The CSS file stays in dist for audits and CSP review.
 */
function inlineReviewCss(): Plugin {
  return {
    name: "wolf-review-inline-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const css = Object.values(bundle).filter((file) => file.type === "asset" && file.fileName.endsWith(".css"));
      if (css.length !== 1) this.error(`expected one CSS asset, found ${css.length}`);
      const asset = css[0]!;
      if (asset.type !== "asset") return;
      const text = typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
      let replaced = 0;
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        file.code = file.code.replace(new RegExp(`(["'\`])${PLACEHOLDER}\\1`, "g"), () => {
          replaced++;
          return JSON.stringify(text);
        });
      }
      if (replaced !== 1) this.error(`expected the CSS placeholder once in the bundle, replaced ${replaced}`);
    },
  };
}

export default defineConfig({
  // Asset and worker URLs relative to the bundle (`new URL("./assets/…", import.meta.url)`), so dist works from any path.
  base: "./",
  plugins: [inlineReviewCss()],
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    copyPublicDir: false,
    lib: {
      entry: {
        "wolf-review": "src/index.ts",
        auto: "src/auto.ts",
        react: "src/react.ts",
        protocol: "src/protocol.ts",
        seal: "src/seal.ts",
      },
      formats: ["es"],
      cssFileName: "wolf-review",
    },
    rolldownOptions: {
      // React is the page's own copy; everything else (Preact included) is bundled.
      external: ["react", "react/jsx-runtime"],
      // Let `auto.js` and `react.js` import the `wolf-review.js` entry instead of both re-exporting a shared chunk.
      preserveEntrySignatures: "allow-extension",
      // Library mode keeps whitespace in ES output; this bundle is an application, so minify fully.
      output: {
        minify: true,
        // Shared and lazy chunks live under `chunks/`; the three authoring plugins are named for what they hold.
        chunkFileNames: (chunk) => {
          const plugin = /\/plugins\/(docs|slides|sheets)\/index\.ts$/.exec(chunk.facadeModuleId ?? "");
          return plugin ? `chunks/plugin-${plugin[1]}-[hash].js` : "chunks/[name]-[hash].js";
        },
      },
    },
  },
});
