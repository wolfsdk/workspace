/**
 * The element's CSS (shell and plugins) is never added to the page: the build
 * collects it into `dist/wolf-review.css` and replaces this placeholder with
 * its text (see `vite.config.ts`), and every element adopts one shared
 * stylesheet in its shadow root.
 */
const EDITOR_CSS: string = "__WOLF_REVIEW_CSS__";

/** Element frame. Page rules on `wolf-review` (size, margins, `--wolf-*` colour tokens) win over `:host`. */
const FRAME_CSS = `
:host {
  display: block;
  position: relative;
  height: 600px;
  min-height: 240px;
  /* No \`contain\` or \`transform\`: either would make this box the containing block of the
   * editor's \`position: fixed\` menus and popovers, clipping them at the element's edge. */
  overflow: hidden;
}
:host([hidden]) { display: none; }
.wolf-embed-root {
  /* Stop inherited page styles (font, color, line-height, letter-spacing, ...) at the shadow boundary.
   * Custom properties still inherit, so --wolf-* tokens set on the element reach the shell. */
  all: initial;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1d1d1f;
  text-align: start;
}
.wolf-embed-root > * { flex: 1 1 auto; min-height: 0; }
/* Agent presence bar: outside the shell, so it reads the public --wolf-* tokens itself. */
[data-part="agent-activity"] {
  --aa-bg: var(--wolf-surface, #f6f7f9);
  --aa-fg: var(--wolf-fg, #1b1d22);
  --aa-line: var(--wolf-border, #d6d8de);
  --aa-dot: var(--wolf-accent, #2463eb);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 8px;
  background: var(--aa-bg);
  color: var(--aa-fg);
  border-bottom: 1px solid var(--aa-line);
}
.wolf-embed-root > [data-part="agent-activity"] { flex: 0 0 auto; }
[data-part="agent-pill"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 2px 10px 2px 8px;
  border: 1px solid var(--aa-dot);
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-part="agent-pill"]::before {
  content: "";
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--aa-dot);
  animation: wolf-agent-pulse 1.4s ease-in-out infinite;
}
@keyframes wolf-agent-pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { [data-part="agent-pill"]::before { animation: none; } }
:host([theme="dark"]) [data-part="agent-activity"] {
  --aa-bg: var(--wolf-dark-surface, #1d1e22);
  --aa-fg: var(--wolf-dark-fg, #e8e9ed);
  --aa-line: var(--wolf-dark-border, #3a3d45);
  --aa-dot: var(--wolf-dark-accent, #6e9cff);
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) [data-part="agent-activity"] {
    --aa-bg: var(--wolf-dark-surface, #1d1e22);
    --aa-fg: var(--wolf-dark-fg, #e8e9ed);
    --aa-line: var(--wolf-dark-border, #3a3d45);
    --aa-dot: var(--wolf-dark-accent, #6e9cff);
  }
}
`;

/** One constructed sheet per stylesheet text, shared by every element that adopts it. */
const sheets = new Map<string, CSSStyleSheet>();
/** The stylesheet texts each shadow root has already taken. */
const adopted = new WeakMap<ShadowRoot, Set<string>>();

/** Add `css` to `root` once: a shared constructed sheet, or a `<style>` where unsupported. */
export function adoptCss(root: ShadowRoot, css: string): void {
  const taken = adopted.get(root) ?? new Set<string>();
  adopted.set(root, taken);
  if (taken.has(css)) return;
  taken.add(css);
  if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
    let sheet = sheets.get(css);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      sheets.set(css, sheet);
    }
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return;
  }
  const style = document.createElement("style");
  style.textContent = css;
  root.append(style);
}

/** Attach the editor CSS (shell and review plugin) to `root`. The authoring plugins bring their own (`adoptCss`). */
export function adoptStyles(root: ShadowRoot): void {
  adoptCss(root, `${EDITOR_CSS}\n${FRAME_CSS}`);
}
