/**
 * `data-testid` values shared by the UI and browser checks. UI code sets them
 * from here; checks select by them. Elements marked "data-*" also carry that
 * attribute with the stated value.
 */
import type { MemberVerdict, ModeId, RivalId } from "./types.ts";

export const TID = {
  // Shell
  shell: "pg-shell",
  /** data-available="true|false" */
  modeTab: (id: ModeId) => `pg-mode-${id}`,
  stage: "pg-stage",
  rail: "pg-rail",
  dropZone: "pg-drop",
  /** The <input type="file"> behind the drop zone. */
  dropInput: "pg-drop-input",
  /** Text content: full lowercase hex sha256 of the current snapshot. */
  docSha: "pg-doc-sha256",
  /** The engine field: a select of sources and a URL input. */
  engineField: "pg-engine",
  engineUrl: "pg-engine-url",
  /** data-phase="idle|loading|ready", data-code="<KernelError.code>" on failure */
  engineStatus: "pg-engine-status",
  /** data-code="<KernelError.code>" */
  errorPanel: "pg-error",

  // Review mode
  reviewElement: "pg-review-element",
  reviewLog: "pg-review-log",
  reviewDownloadBytes: "pg-review-download-bytes",
  reviewDownloadSession: "pg-review-download-session",

  // Mangle-Off mode
  mangleRun: "pg-mangle-run",
  mangleRival: (rival: RivalId) => `pg-mangle-rival-${rival}`,
  /** data-state="idle|running|done|error" */
  mangleLane: (who: "wolf" | RivalId) => `pg-mangle-lane-${who}`,
  /** Text content: the count for that verdict. */
  mangleCount: (who: "wolf" | RivalId, verdict: MemberVerdict) => `pg-mangle-${who}-${verdict}`,
  mangleScript: "pg-mangle-script",
  mangleScriptRun: "pg-mangle-script-run",

  // X-ray mode
  /** Text content: number of findings. */
  xrayCount: "pg-xray-count",
  xrayFinding: (id: string) => `pg-xray-finding-${id}`,
  xrayParserPane: "pg-xray-parser",

  // Recalc mode
  recalcRun: "pg-recalc-run",
  /** Text content: number of mismatched cells. */
  recalcCount: "pg-recalc-count",
  recalcRow: (sheet: string, a1: string) => `pg-recalc-${sheet}-${a1}`,

  // Code drawer
  codeOpen: "pg-code-open",
  codeTab: (kind: "batches" | "cli" | "python" | "mcp" | "typescript") => `pg-code-tab-${kind}`,
  /** Text content: the generated code of the selected tab. */
  codeText: "pg-code-text",
} as const;
