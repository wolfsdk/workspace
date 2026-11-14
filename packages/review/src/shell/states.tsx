import type { DocFormat, KernelError } from "@wolfsdk/protocol";
import type { EngineStatus } from "./engine.ts";
import { FormatIcon, Icon } from "./icons.tsx";
import { keysOf } from "./shortcuts.ts";

/** A document the landing offers. `quick`: also a one-click button in the drop zone (one per format reads best). */
export type Sample = { label: string; url: string; quick?: boolean };

const FORMATS: { format: DocFormat; title: string }[] = [
  { format: "docx", title: "Documents" },
  { format: "pptx", title: "Presentations" },
  { format: "xlsx", title: "Spreadsheets" },
];

export function sampleFormat(sample: Sample): DocFormat | null {
  const m = /\.(docx|pptx|xlsx)(?:$|[?#])/i.exec(sample.url) ?? /\.(docx|pptx|xlsx)$/i.exec(sample.label);
  return m ? (m[1]!.toLowerCase() as DocFormat) : null;
}
/** Largest file the editor opens (the engine holds the file, its revisions and its layout in browser memory). */
export const MAX_FILE_BYTES = 100 * 2 ** 20;

/** A file that could not be opened, in words a reader can act on; the engine's code stays visible. */
export type OpenProblem = { name: string; title: string; detail: string; code: string; message?: string };

const LEGACY: Record<string, string> = {
  doc: "Word 97-2003 (.doc)",
  xls: "Excel 97-2003 (.xls)",
  ppt: "PowerPoint 97-2003 (.ppt)",
  docm: "macro-enabled Word (.docm)",
  xlsm: "macro-enabled Excel (.xlsm)",
  pptm: "macro-enabled PowerPoint (.pptm)",
  odt: "OpenDocument text (.odt)",
  ods: "OpenDocument spreadsheet (.ods)",
  odp: "OpenDocument presentation (.odp)",
};
const SAVE_AS: Record<string, string> = {
  doc: "docx",
  docm: "docx",
  odt: "docx",
  xls: "xlsx",
  xlsm: "xlsx",
  ods: "xlsx",
  ppt: "pptx",
  pptm: "pptx",
  odp: "pptx",
};

const sizeText = (n: number) =>
  n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Checks made before the engine sees the file: size, and that it is an Office Open XML package. */
export function checkFile(name: string, size: number, head: Uint8Array | null): OpenProblem | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (size > MAX_FILE_BYTES) {
    return {
      name,
      code: "file-too-large",
      title: `${name} is too large to open here`,
      detail: `It is ${sizeText(size)}; the editor opens files up to ${sizeText(MAX_FILE_BYTES)} because everything runs in this browser tab. Compress its pictures or split it, then open it again.`,
    };
  }
  if (size === 0) {
    return {
      name,
      code: "file-empty",
      title: `${name} is empty`,
      detail: "The file has no content. Choose the document again, or a copy of it.",
    };
  }
  const zip =
    !!head && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (zip || ext === "docx" || ext === "pptx" || ext === "xlsx") return null;
  const legacy = LEGACY[ext];
  return {
    name,
    code: "unsupported-file-type",
    title: `${name} is not a file this editor opens`,
    detail: legacy
      ? `It is a ${legacy} file. Open it in its original program, save it as .${SAVE_AS[ext]}, and open that copy here.`
      : "The editor opens Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files. Choose one of those.",
  };
}

/** What a refused open means for the reader. */
export function describeOpenFailure(error: KernelError, name: string): OpenProblem {
  const base = { name, code: error.code, message: error.message };
  if (error.code === "format-mismatch" || error.code === "unsupported-format" || error.code.startsWith("package-")) {
    return {
      ...base,
      title: `${name} could not be read`,
      detail:
        "The file is damaged or is not a Word, PowerPoint or Excel document. If it opens in its original program, save a new copy there and open that copy here.",
    };
  }
  if (error.code === "out-of-memory" || error.code === "memory-limit" || /memory/i.test(error.code)) {
    return {
      ...base,
      title: `${name} needs more memory than this tab has`,
      detail: "Close other documents or tabs and try again, or open a smaller file.",
    };
  }
  return {
    ...base,
    title: `${name} could not be opened`,
    detail: "The engine refused the file. Try again; if it keeps failing, the details below say why.",
  };
}

export function ProblemNotice({ problem, onDismiss }: { problem: OpenProblem; onDismiss: () => void }) {
  return (
    <div class="we-notice we-notice--error we-shell-problem" role="alert" data-testid="shell-open-problem">
      <Icon name="alert" />
      <div>
        <strong data-testid="shell-open-problem-title">{problem.title}</strong>
        <p data-testid="shell-open-problem-detail">{problem.detail}</p>
        <p class="we-shell-problem-code">
          <code data-testid="shell-open-problem-code">{problem.code}</code>
          {problem.message && ` ${problem.message}`}
        </p>
      </div>
      <button
        class="we-btn we-btn--icon we-btn--small"
        title="Dismiss"
        aria-label="Dismiss this message"
        data-testid="shell-open-problem-dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

export function Landing({
  samples,
  problem,
  engine,
  onDismissProblem,
  onOpen,
  onSample,
}: {
  samples: Sample[];
  problem: OpenProblem | null;
  engine: EngineStatus | null;
  onDismissProblem: () => void;
  onOpen: () => void;
  onSample: (s: Sample) => void;
}) {
  const indexed = samples.map((sample, index) => ({ sample, index, format: sampleFormat(sample) }));
  const groups = FORMATS.map((g) => ({ ...g, items: indexed.filter((s) => s.format === g.format) })).filter(
    (g) => g.items.length,
  );
  const other = indexed.filter((s) => s.format === null);
  const quick = indexed.filter((s) => s.sample.quick);
  return (
    <div class="we-shell-landing" data-testid="shell-empty">
      {problem && <ProblemNotice problem={problem} onDismiss={onDismissProblem} />}
      <div class="we-shell-dropzone">
        <span class="we-shell-dropzone-icon">
          <Icon name="upload" size={28} />
        </span>
        <h1 class="we-shell-landing-title">Open a document</h1>
        <p class="we-shell-muted">
          Drop a Word, PowerPoint or Excel file (.docx, .pptx, .xlsx, up to {sizeText(MAX_FILE_BYTES)}) here, or choose
          one. It stays on this computer: the engine runs in your browser.
        </p>
        <button
          class="we-btn we-btn--primary we-shell-landing-open"
          title={`Choose a file to open (${keysOf("open")})`}
          aria-label="Choose a file to open"
          data-testid="shell-empty-open"
          onClick={onOpen}
        >
          <Icon name="open" />
          Choose a file
        </button>
        {quick.length > 0 ? (
          <div class="we-shell-quick" role="group" aria-label="Try a sample">
            <span class="we-shell-muted">Or try a sample:</span>
            {quick.map(({ sample, format }) => (
              <button
                key={sample.url}
                class="we-btn we-shell-quick-sample"
                title={`Open the sample ${sample.label}`}
                aria-label={`Open the sample ${sample.label}`}
                data-testid={`shell-quick-sample-${format ?? sample.label}`}
                onClick={() => onSample(sample)}
              >
                {format && <FormatIcon format={format} size={18} />}
                {format ? FORMATS.find((f) => f.format === format)!.title.replace(/s$/, "") : sample.label}
              </button>
            ))}
          </div>
        ) : (
          <div class="we-shell-landing-formats" aria-hidden="true">
            <FormatIcon format="docx" size={18} /> DOCX <FormatIcon format="pptx" size={18} /> PPTX{" "}
            <FormatIcon format="xlsx" size={18} /> XLSX
          </div>
        )}
        {engine && <EngineLine engine={engine} />}
      </div>
      {samples.length > 0 && (
        <section class="we-shell-samples" aria-label="Sample documents">
          <h2 class="we-shell-samples-title">Samples</h2>
          <div class="we-shell-sample-groups">
            {[...groups, ...(other.length ? [{ format: null, title: "Other", items: other }] : [])].map((group) => (
              <div class="we-shell-sample-group" key={group.title}>
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map(({ sample, index, format }) => (
                    <li key={sample.url}>
                      <button
                        class="we-shell-sample"
                        title={`Open ${sample.label}`}
                        aria-label={`Open sample ${sample.label}`}
                        data-testid={`shell-sample-${index}`}
                        onClick={() => onSample(sample)}
                      >
                        {format && <FormatIcon format={format} size={22} />}
                        <span class="we-shell-sample-name">{sample.label.replace(/\.(docx|pptx|xlsx)$/i, "")}</span>
                        <span class="we-shell-sample-ext">{format?.toUpperCase()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The engine's first-load state under the drop zone: bytes downloaded (of the total when known),
 * then downloaded or ready. One line of fixed height, so nothing moves as it changes.
 */
function EngineLine({ engine }: { engine: EngineStatus }) {
  const { stage, loaded, total, downloadMs, transferred } = engine;
  let text: string;
  if (stage === "downloading")
    text = total ? `Downloading the engine: ${MB(loaded)} of ${MB(total)}` : `Downloading the engine: ${MB(loaded)}`;
  else if (stage === "compiling") text = "Compiling the engine";
  else if (stage === "failed") text = "The engine did not load";
  else {
    const how =
      transferred === 0
        ? " from the browser cache"
        : downloadMs !== null
          ? ` in ${(downloadMs / 1000).toFixed(1)} s`
          : "";
    // Downloaded: the worker compiles it on the first open (shown in the open's stages).
    text = `${stage === "ready" ? "Engine ready" : "Engine downloaded"} (${MB(loaded)}${how})`;
  }
  const pct =
    stage === "downloading" && total
      ? Math.min(100, Math.round((loaded / total) * 100))
      : stage === "downloading"
        ? null
        : 100;
  return (
    <div class="we-shell-engine-line" data-testid="shell-engine-status" data-stage={stage}>
      <span class="we-shell-muted">{text}</span>
      <div
        class={`we-shell-progress${pct === null ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-label="Engine download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={text}
        data-testid="shell-engine-progress"
      >
        <div class="we-shell-progress-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

/** Where an open stands; `engine` stages only appear when the engine was not ready when it started. */
export type OpenStep = "file" | "engine" | "open" | "page";
export type OpenProgress = { name: string; step: OpenStep; engineStages: boolean };

type Stage = { key: string; label: string; state: "done" | "active" | "todo"; detail?: string; testid: string };

const MB = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;

function stagesOf(
  progress: OpenProgress,
  engine: EngineStatus | null,
): { stages: Stage[]; fraction: number; determinate: boolean } {
  const { step, name } = progress;
  const engineStages = progress.engineStages && !!engine;
  const downloading = engine?.stage === "downloading";
  const compiled = engine?.stage === "ready";
  const pick = (done: boolean, active: boolean): Stage["state"] => (done ? "done" : active ? "active" : "todo");
  // Each stage's share of the bar and how far it is.
  const parts: { stage: Stage; weight: number; fraction?: number }[] = [];
  if (step === "file") {
    parts.push({
      stage: { key: "file", label: `Fetching ${name}`, state: "active", testid: "shell-stage-file" },
      weight: 0,
    });
  }
  if (engineStages && engine) {
    const bytes = engine.total
      ? `${MB(engine.loaded)} of ${MB(engine.total)}`
      : engine.loaded
        ? MB(engine.loaded)
        : undefined;
    const took =
      engine.downloadMs !== null ? `${MB(engine.loaded)} in ${(engine.downloadMs / 1000).toFixed(1)} s` : undefined;
    parts.push({
      stage: {
        key: "download",
        label: "Downloading the engine",
        state: pick(!downloading, downloading && step !== "file"),
        detail: downloading ? bytes : took,
        testid: "shell-stage-download",
      },
      weight: 0.45,
      fraction: downloading && engine.total ? engine.loaded / engine.total : undefined,
    });
    parts.push({
      stage: {
        key: "compile",
        label: "Compiling the engine",
        state: pick(compiled || step === "page", step === "open" && !compiled),
        testid: "shell-stage-compile",
      },
      weight: 0.15,
    });
  }
  parts.push({
    stage: {
      key: "open",
      label: `Opening ${name}`,
      state: pick(step === "page", step === "open" && (!engineStages || compiled)),
      testid: "shell-stage-open",
    },
    weight: engineStages ? 0.28 : 0.7,
  });
  parts.push({
    stage: {
      key: "page",
      label: "Rendering the first page",
      state: pick(false, step === "page"),
      testid: "shell-stage-page",
    },
    weight: engineStages ? 0.12 : 0.3,
  });
  let fraction = 0;
  let determinate = false;
  for (const p of parts) {
    if (p.stage.state === "done") fraction += p.weight;
    else if (p.stage.state === "active" && p.fraction !== undefined) {
      fraction += p.weight * p.fraction;
      determinate = true;
    }
  }
  return { stages: parts.map((p) => p.stage), fraction, determinate };
}

export function LoadingStages(props: {
  progress: OpenProgress;
  engine: EngineStatus | null;
  compact?: boolean;
  testid: string;
}) {
  const { stages, fraction, determinate } = stagesOf(props.progress, props.engine);
  const pct = Math.round(fraction * 100);
  return (
    <div
      class={`we-shell-loading${props.compact ? " is-compact" : ""}`}
      data-testid={props.testid}
      role="status"
      aria-live="polite"
    >
      <div class="we-shell-loading-card">
        <div class="we-shell-loading-title">Opening {props.progress.name}</div>
        <div
          class={`we-shell-progress${determinate ? "" : " is-indeterminate"}`}
          role="progressbar"
          aria-label="Opening progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          data-testid="shell-progress"
        >
          <div class="we-shell-progress-fill" style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
        <ol class="we-shell-stages">
          {stages.map((s) => (
            <li key={s.key} class={`we-shell-stage is-${s.state}`} data-testid={s.testid} data-state={s.state}>
              <span class="we-shell-stage-mark" aria-hidden="true">
                {s.state === "done" ? (
                  <Icon name="check" size={14} />
                ) : s.state === "active" ? (
                  <span class="we-shell-spinner" />
                ) : null}
              </span>
              <span class="we-shell-stage-label">{s.label}</span>
              {s.detail && <span class="we-shell-stage-detail">{s.detail}</span>}
            </li>
          ))}
        </ol>
        {props.engine && props.engine.stage !== "ready" && props.progress.engineStages && (
          <div class="we-shell-muted we-shell-loading-note" data-testid="shell-loading-engine">
            The first open downloads and compiles the engine{props.engine.total ? ` (${MB(props.engine.total)})` : ""};
            later opens and visits reuse it.
          </div>
        )}
      </div>
    </div>
  );
}

export function FatalState({ error, onRetry }: { error: KernelError; onRetry: () => void }) {
  return (
    <div class="we-shell-landing" data-testid="shell-fatal">
      <div class="we-shell-fatal we-notice we-notice--error" role="alert">
        <span class="we-shell-fatal-icon">
          <Icon name="alert" size={28} />
        </span>
        <div>
          <h1 class="we-shell-landing-title">The editor engine could not be loaded</h1>
          <p>Nothing was opened or changed. Check the connection and try again.</p>
          <p>
            <strong data-testid="shell-fatal-code">{error.code}</strong>{" "}
            <span data-testid="shell-fatal-message">{error.message}</span>
          </p>
          {error.argument !== undefined && <code class="we-shell-error-argument">{error.argument}</code>}
          <div>
            <button
              class="we-btn we-btn--primary"
              title="Start the engine again"
              aria-label="Retry loading the engine"
              data-testid="shell-fatal-retry"
              onClick={onRetry}
            >
              <Icon name="refresh" />
              Retry
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
