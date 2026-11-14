import { type LabMode, type ModeProps, TID } from "../lab/index.ts";
import type { ComponentType } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type IncomingFile, ShellController, type ShellProps } from "./controller.ts";
import { DropZone, incomingFiles } from "./DropZone.tsx";
import { EngineField } from "./EngineField.tsx";
import { ErrorPanel, StageBoundary } from "./ErrorPanel.tsx";
import { modeAvailability, type ShellState } from "./logic.ts";
import { onTablistKeyDown, tabIndexFor } from "./tablist.ts";

export type { ShellProps } from "./controller.ts";

/** The playground: engine field, file picker, mode switcher, stage and rail. */
export const PlaygroundShell: ComponentType<ShellProps> = (props) => {
  const [controller] = useState(() => new ShellController(props));
  const [, setVersion] = useState(0);
  useEffect(() => {
    const off = controller.subscribe(() => setVersion((v) => v + 1));
    const stop = controller.start();
    return () => {
      off();
      stop();
    };
  }, [controller]);
  return <ShellView controller={controller} state={controller.state} />;
};

/** Renders one controller state. Split from `PlaygroundShell` so tests can render it. */
export function ShellView({ controller, state }: { controller: ShellController; state: ShellState }) {
  const { deps, modes, engines } = controller.props;
  const engine = controller.engine;
  const { doc, phase } = state;
  const mode = controller.mode;
  const ctx = controller.modeContext();
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const focusStage = useRef(false);
  const codeToggle = useRef<HTMLButtonElement>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const journal = useMemo(() => (doc ? engine.journal(doc) : null), [engine, doc]);

  useEffect(() => {
    if (!focusStage.current) return;
    focusStage.current = false;
    stageHeading.current?.focus();
  }, [state.modeId]);

  const chooseMode = (m: LabMode) => {
    if (m.id === state.modeId) return;
    focusStage.current = controller.selectMode(m.id);
  };

  const selectedMode = modes.findIndex((m) => m.id === state.modeId);
  const identity = engine.identity;
  const fileName = state.file?.name ?? "The document";

  const modeProps: ModeProps | null =
    doc && state.picked && mode?.kind === "doc"
      ? { engine, file: state.picked, doc, onDoc: controller.onDoc, deps, bus: controller.bus }
      : null;
  const Rail = mode?.kind === "doc" ? mode.Rail : undefined;

  let stageBody;
  if (mode?.kind === "surface") {
    stageBody = (
      <StageBoundary key={`${mode.id}:${state.seq}`}>
        <mode.Stage file={state.picked} engine={state.source} />
      </StageBoundary>
    );
  } else if (phase === "reading") {
    stageBody = (
      <p class="lab-stage__wait" role="status">
        Reading {fileName}.
      </p>
    );
  } else if (phase === "opening") {
    stageBody = (
      <p class="lab-stage__wait" role="status">
        {state.engine.loading ? `Loading the engine before opening ${fileName}.` : `Opening ${fileName}.`}
      </p>
    );
  } else if (phase === "failed" && state.error) {
    stageBody = <ErrorPanel error={state.error} title={`${fileName} did not open.`} />;
  } else if (!mode) {
    stageBody = (
      <div class="lab-stage__none">
        <p>No mode can run on this document.</p>
        <ul>
          {modes.map((m) => {
            const availability = modeAvailability(m, ctx);
            return <li key={m.id}>{availability.available ? m.title : `${m.title}: ${availability.reason}`}</li>;
          })}
        </ul>
      </div>
    );
  } else if (!modeProps) {
    stageBody = <p class="lab-stage__wait">Drop a file to inspect it.</p>;
  } else {
    stageBody = (
      <StageBoundary key={`${mode.id}:${modeProps.doc.id}:${state.seq}`}>
        <mode.Stage {...modeProps} />
      </StageBoundary>
    );
  }

  return (
    <div
      class="lab-shell"
      data-testid={TID.shell}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        // A file dropped outside the drop zone would otherwise replace the page.
        event.preventDefault();
        const files = incomingFiles(event.dataTransfer?.files);
        if (files.length > 0) void controller.openOwnFile(files);
      }}
    >
      <a class="lab-skip" href="#lab-stage">
        Skip to the stage
      </a>
      <header class="lab-header">
        <div class="lab-bar">
          <p class="lab-brand">
            <span class="lab-brand__name">Wolf</span> <span class="lab-brand__lab">Playground</span>
          </p>
          <EngineField
            status={state.engine}
            source={state.source}
            choices={engines}
            onSource={(source) => void controller.setEngineSource(source)}
            onLoad={() => void controller.loadEngine()}
          />
        </div>
        <h1 class="lab-title">Review, edit and inspect an Office file in this tab</h1>
      </header>

      <div class="lab-picker">
        <DropZone
          file={state.file}
          active={state.file !== null}
          error={state.dropError}
          onFiles={(files: IncomingFile[]) => void controller.openOwnFile(files)}
        />
      </div>

      <div class="lab-main">
        <main class="lab-column">
          <div role="tablist" aria-label="Modes" class="lab-tabs lab-modes" onKeyDown={onTablistKeyDown}>
            {modes.map((m, index) => {
              const availability = modeAvailability(m, ctx);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  class="lab-tab lab-tab--mode"
                  data-testid={TID.modeTab(m.id)}
                  data-available={String(availability.available)}
                  aria-selected={m.id === state.modeId}
                  aria-disabled={availability.available ? undefined : "true"}
                  aria-controls="lab-stage"
                  tabIndex={tabIndexFor(index, selectedMode)}
                  onClick={() => availability.available && chooseMode(m)}
                >
                  <span class="lab-tab__title">{m.title}</span>
                  <span class="lab-tab__hook">{availability.available ? m.summary : availability.reason}</span>
                </button>
              );
            })}
          </div>

          <section
            id="lab-stage"
            class="lab-stage"
            role="tabpanel"
            data-testid={TID.stage}
            data-mode={mode?.id ?? ""}
            aria-labelledby="lab-stage-title"
          >
            <h2 id="lab-stage-title" class="lab-stage__title" ref={stageHeading} tabIndex={-1}>
              {mode ? (state.file ? `${mode.title}: ${state.file.name}` : mode.title) : "Stage"}
            </h2>
            {stageBody}
          </section>

          {mode?.kind === "doc" && (
            <div class="lab-code">
              <button
                ref={codeToggle}
                type="button"
                class="lab-button"
                data-testid={TID.codeOpen}
                aria-expanded={codeOpen}
                aria-controls="lab-code-drawer"
                disabled={!journal}
                onClick={() => setCodeOpen((open) => !open)}
              >
                {codeOpen ? "Hide the code for these steps" : "Show the code for these steps"}
              </button>
              <div
                id="lab-code-drawer"
                class="lab-code__drawer"
                hidden={!codeOpen || !journal}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setCodeOpen(false);
                  codeToggle.current?.focus();
                }}
              >
                {codeOpen && journal && <deps.CodeDrawer journal={journal} />}
              </div>
            </div>
          )}
        </main>

        <aside class="lab-rail" data-testid={TID.rail} aria-label="Details">
          <section class="lab-panel" aria-labelledby="lab-snapshot-title">
            <h3 id="lab-snapshot-title" class="lab-panel__title">
              Current snapshot
            </h3>
            {doc ? (
              <dl class="lab-facts">
                <dt>File</dt>
                <dd>
                  {doc.name} <span class="lab-format">{doc.format}</span>
                </dd>
                <dt>sha256</dt>
                <dd>
                  <code class="lab-hash" data-testid={TID.docSha}>
                    {doc.sha256}
                  </code>
                </dd>
                <dt>Opened as</dt>
                <dd>
                  <code class="lab-hash">{doc.baseSha256}</code>
                </dd>
              </dl>
            ) : (
              <p class="lab-panel__hint">
                {mode?.kind === "surface"
                  ? "The review element keeps its own snapshot; its events are listed on the stage."
                  : "Nothing open yet."}
              </p>
            )}
          </section>

          {Rail && modeProps && (
            <StageBoundary key={`rail:${mode!.id}:${modeProps.doc.id}:${state.seq}`}>
              <Rail {...modeProps} />
            </StageBoundary>
          )}
        </aside>
      </div>

      <footer class="lab-footer">
        <dl class="lab-identity">
          <dt>Engine</dt>
          <dd>{identity ? (identity.version ?? "Version not given") : "Not loaded"}</dd>
          {identity && (
            <>
              <dt>Module sha256</dt>
              <dd>
                <code class="lab-hash">{identity.moduleSha256}</code>
              </dd>
              <dt>From</dt>
              <dd>
                <code>{identity.url}</code>
              </dd>
            </>
          )}
        </dl>
      </footer>

      <div class="lab-visually-hidden" aria-live="polite" aria-atomic="true">
        <p key={state.announcement.n}>{state.announcement.text}</p>
      </div>
      {state.toasts.length > 0 && (
        <div class="lab-toasts" role="region" aria-label="Messages">
          {state.toasts.map((toast) => (
            <div key={toast.id} class={`lab-toast lab-toast--${toast.tone}`}>
              <span class="lab-mark" aria-hidden="true">
                {toast.tone === "error" ? "!" : "i"}
              </span>
              <span class="lab-toast__message">{toast.message}</span>
              <button
                type="button"
                class="lab-button lab-button--small"
                onClick={() => controller.dispatch({ type: "toast-dismiss", id: toast.id })}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
