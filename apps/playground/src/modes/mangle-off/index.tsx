/** @jsxImportSource preact */
/**
 * Mangle-Off: the same edit through Wolf and one rival library, side by
 * side, with what each did to the rest of the package. Everything external
 * arrives in `ModeProps`; the wording and lane state live in `model.ts`.
 */
import {
  type EditIntent,
  type LabDoc,
  type LabMode,
  MEMBER_VERDICTS,
  type ModeProps,
  type PackageInfo,
  type RivalId,
  type RivalRecord,
  TID,
} from "../../lab/index.ts";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  countRows,
  defaultIntentFor,
  editableKind,
  initialLanes,
  intentLabel,
  intentValid,
  kernelErrorOf,
  type Lanes,
  type LaneView,
  noLaneMessage,
  type OfferedRival,
  offeredRivals,
  type PreviewPlan,
  rivalLaneFromFailure,
  rivalLaneUnsupported,
  runningLane,
  wolfLaneFromFailure,
} from "./model.ts";
import { comparisonInput, inputInfo, resolvePreview, type RunContext, type RunInput, runRival, runWolf } from "./run.ts";
import "./mangle-off.css";

function Stage(props: ModeProps) {
  // A visitor's new file starts the mode over; a step this mode applies keeps the same document id.
  return <MangleStage key={props.doc.id} {...props} />;
}

function MangleStage(props: ModeProps) {
  const { engine, doc, deps } = props;
  const format = doc.format;
  const offered = useMemo(() => offeredRivals(deps.rivals.supports, format), [deps.rivals, format]);
  const [rivalId, setRivalId] = useState<RivalId | null>(offered[0]?.rival ?? null);
  const rival: OfferedRival | null = offered.find((o) => o.rival === rivalId) ?? null;
  const [intent, setIntent] = useState<EditIntent>(() => defaultIntentFor(format));
  const [info, setInfo] = useState<PackageInfo | null>(null);
  const [ran, setRan] = useState<Lanes | null>(null);
  const [busy, setBusy] = useState(false);
  const [python, setPython] = useState("");
  const [script, setScript] = useState<RivalRecord | { error: string } | null>(null);
  const [muted, setMuted] = useState(deps.geiger.muted);
  const runToken = useRef(0);

  useEffect(() => {
    let live = true;
    void inputInfo(engine, doc, deps.verifier).then((next) => live && setInfo(next));
    return () => {
      live = false;
    };
  }, [engine, deps.verifier, doc.sha256]);

  const idle = useMemo(() => initialLanes(rival, info), [rival, info]);
  const lanes = ran ?? idle;

  const selectRival = (next: RivalId) => {
    runToken.current++;
    setRivalId(next);
    setRan(null);
    // Script output belongs to the run and the tool it came from.
    setScript(null);
    setBusy(false);
  };

  const run = async () => {
    const token = ++runToken.current;
    const caption = intentLabel(intent);
    let state: Lanes = {
      wolf: runningLane(lanes.wolf, caption),
      rival: lanes.rival && rival ? runningLane(lanes.rival, caption) : null,
    };
    const set = (patch: Partial<Lanes>) => {
      if (token !== runToken.current) return;
      state = { ...state, ...patch };
      setRan(state);
    };
    setBusy(true);
    setRan(state);
    setScript(null);
    try {
      let input: RunInput;
      try {
        input = await comparisonInput(engine, doc);
      } catch (error) {
        set({
          wolf: wolfLaneFromFailure(error, info, caption),
          rival: rival ? rivalLaneFromFailure(rival.rival, error, info, caption) : null,
        });
        return;
      }
      const ctx = runContext();
      await Promise.all([
        runWolf(ctx, input, intent, caption).then((wolf) => set({ wolf })),
        rival ? runRival(ctx, rival, input, intent, caption).then(({ lane }) => set({ rival: lane })) : null,
      ]);
    } finally {
      if (token === runToken.current) setBusy(false);
    }
  };

  const start = () => {
    if (!busy && intentValid(intent)) void run();
  };

  const runContext = (): RunContext => ({ engine, deps, format, info, onDoc: props.onDoc });

  const runScript = async () => {
    if (!rival) return;
    const token = ++runToken.current;
    const scriptIntent: EditIntent = { kind: "user-script", python };
    const caption = intentLabel(scriptIntent);
    const set = (lane: LaneView) => {
      if (token !== runToken.current) return;
      setRan({ wolf: lanes.wolf, rival: lane });
    };
    setBusy(true);
    setScript(null);
    set(runningLane(lanes.rival ?? rivalLaneUnsupported(rival.rival, info, caption), caption));
    try {
      const input = await comparisonInput(engine, doc);
      const { lane, record } = await runRival(runContext(), rival, input, scriptIntent, caption);
      set(lane);
      if (token === runToken.current) setScript(record ?? { error: lane.error?.title ?? "The script did not run." });
    } catch (error) {
      if (token !== runToken.current) return;
      setScript({ error: error instanceof Error ? error.message : String(error) });
      set(rivalLaneFromFailure(rival.rival, error, info, caption));
    } finally {
      if (token === runToken.current) setBusy(false);
    }
  };

  const previewFor = (plan: PreviewPlan) => resolvePreview(engine, plan, `${rival?.rival ?? "rival"}-output.${format}`);

  const toggleSound = (on: boolean) => {
    deps.geiger.setMuted(!on);
    setMuted(!on);
  };

  const { Legend } = deps;

  return (
    <div class="mangle">
      <form
        class="mangle-controls"
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          const target = event.target;
          if (event.key !== "Enter" || event.isComposing || !(target instanceof HTMLInputElement)) return;
          if (target.type !== "text" && target.type !== "number") return;
          event.preventDefault();
          start();
        }}
      >
        <IntentFields format={format} intent={intent} onChange={setIntent} />
        {offered.length > 0 ? (
          <fieldset class="mangle-rivals">
            <legend>Rival library</legend>
            {offered.map((offer) => (
              <label key={offer.rival} class="mangle-rival">
                <input
                  type="radio"
                  name="mangle-rival"
                  value={offer.rival}
                  checked={offer.rival === rivalId}
                  data-testid={TID.mangleRival(offer.rival)}
                  onChange={() => selectRival(offer.rival)}
                />
                <span>
                  <strong>{offer.rival}</strong>
                  <span class="mangle-muted">Runs in this tab under Pyodide.</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div class="mangle-actions">
          <button type="button" data-testid={TID.mangleRun} disabled={busy || !intentValid(intent)} onClick={start}>
            Run
          </button>
          <label class="mangle-check">
            <input type="checkbox" checked={!muted} onChange={(e) => toggleSound(e.currentTarget.checked)} />
            Play a tick for each changed byte
          </label>
        </div>
        <p class="mangle-muted">
          The comparison checks which package parts changed, so it can miss a loss inside a part that is otherwise kept.
        </p>
      </form>

      <Legend verdicts={MEMBER_VERDICTS} />

      <div class="mangle-lanes">
        <Lane lane={lanes.wolf} props={props} resolve={previewFor} />
        {lanes.rival ? (
          <Lane lane={lanes.rival} props={props} resolve={previewFor} />
        ) : (
          <section class="mangle-lane mangle-lane-empty" aria-label="No rival lane">
            <p>{noLaneMessage(format)}</p>
          </section>
        )}
      </div>

      {rival ? (
        <section class="mangle-script" data-testid={TID.mangleScript} aria-label="Your own script">
          <h3>Try your own script</h3>
          <p class="mangle-muted">
            Paste Python that edits the file with {rival.rival}. It runs in this tab on the same input, and the{" "}
            {rival.rival} lane shows what it did to the package.
          </p>
          <label class="mangle-field mangle-field-wide">
            <span>Python</span>
            <textarea
              rows={8}
              spellcheck={false}
              value={python}
              onInput={(e) => setPython(e.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            data-testid={TID.mangleScriptRun}
            disabled={busy || python.trim() === ""}
            onClick={() => void runScript()}
          >
            Run script
          </button>
          {script ? <ScriptOutput result={script} /> : null}
        </section>
      ) : null}
    </div>
  );
}

function ScriptOutput({ result }: { result: RivalRecord | { error: string } }) {
  if (!("rival" in result)) return <p class="mangle-error">{result.error}</p>;
  return (
    <div class="mangle-script-out">
      {!result.ok ? <p class="mangle-error">The script raised an error: {result.error ?? "no error text was returned"}</p> : null}
      <h4>stdout</h4>
      <pre>{result.stdout || "(empty)"}</pre>
      <h4>stderr</h4>
      <pre>{result.stderr || "(empty)"}</pre>
    </div>
  );
}

function IntentFields({
  format,
  intent,
  onChange,
}: {
  format: LabDoc["format"];
  intent: EditIntent;
  onChange: (intent: EditIntent) => void;
}) {
  const kind = editableKind(format);
  if (intent.kind !== kind) return null;
  switch (intent.kind) {
    case "set-cell": {
      const numeric = typeof intent.value === "number";
      const setValue = (raw: string, asNumber: boolean) => {
        const n = Number(raw);
        onChange({ ...intent, value: asNumber && raw.trim() !== "" && Number.isFinite(n) ? n : raw });
      };
      return (
        <fieldset class="mangle-intent">
          <legend>Set one cell</legend>
          <Field label="Sheet" value={intent.sheet} onInput={(sheet) => onChange({ ...intent, sheet })} />
          <Field label="Cell" value={intent.a1} onInput={(a1) => onChange({ ...intent, a1 })} />
          <Field label="Value" value={String(intent.value)} onInput={(raw) => setValue(raw, numeric)} />
          <label class="mangle-check">
            <input type="checkbox" checked={numeric} onChange={(e) => setValue(String(intent.value), e.currentTarget.checked)} />
            Store as a number
          </label>
        </fieldset>
      );
    }
    case "replace-text":
      return (
        <fieldset class="mangle-intent">
          <legend>Replace text</legend>
          <Field label="Find" value={intent.find} onInput={(find) => onChange({ ...intent, find })} />
          <Field label="Replace with" value={intent.replace} onInput={(replace) => onChange({ ...intent, replace })} />
        </fieldset>
      );
    case "set-shape-text":
      return (
        <fieldset class="mangle-intent">
          <legend>Set the text of one shape</legend>
          <label class="mangle-field">
            <span>Slide</span>
            <input
              type="number"
              min={1}
              step={1}
              value={intent.slide}
              onInput={(e) => onChange({ ...intent, slide: Number(e.currentTarget.value) })}
            />
          </label>
          <Field label="Shape" value={intent.shape} onInput={(shape) => onChange({ ...intent, shape })} />
          <Field label="Text" value={intent.text} onInput={(text) => onChange({ ...intent, text })} />
        </fieldset>
      );
  }
}

function Field({ label, value, onInput }: { label: string; value: string; onInput: (value: string) => void }) {
  return (
    <label class="mangle-field">
      <span>{label}</span>
      <input type="text" value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    </label>
  );
}

function Lane({
  lane,
  props,
  resolve,
}: {
  lane: LaneView;
  props: ModeProps;
  resolve: (plan: PreviewPlan) => Promise<Uint8Array<ArrayBuffer>>;
}) {
  const { AnatomyMap, ByteRibbon } = props.deps;
  const who = lane.who;
  return (
    <section
      class="mangle-lane"
      data-testid={TID.mangleLane(who)}
      data-state={lane.state}
      aria-busy={lane.state === "running"}
      aria-label={`${lane.title} lane`}
    >
      <header class="mangle-lane-head">
        <h3>{lane.title}</h3>
        <span class="mangle-badge">{stateLabel(lane.state)}</span>
      </header>
      {lane.caption ? <p class="mangle-caption">{lane.caption}</p> : null}
      {lane.resultSha256 ? (
        <p class="mangle-sha">
          Result sha256 <code>{lane.resultSha256}</code>
        </p>
      ) : null}
      <LanePreview plan={lane.preview} resolve={resolve} alt={`Page 1 as ${lane.title} left it`} />
      {lane.error ? (
        <div class="mangle-error" data-code={lane.error.code}>
          <strong>{lane.error.title}</strong>
          {lane.error.code || lane.error.detail ? (
            <p>{[lane.error.code, lane.error.detail].filter(Boolean).join(": ")}</p>
          ) : null}
        </div>
      ) : null}
      {lane.note ? <p class="mangle-muted">{lane.note}</p> : null}
      {lane.info ? (
        <div class="mangle-anatomy">
          <AnatomyMap info={lane.info} delta={lane.delta ?? undefined} label={`Package parts, ${lane.title}`} />
          <ByteRibbon info={lane.info} delta={lane.delta ?? undefined} label={`Package bytes, ${lane.title}`} />
        </div>
      ) : null}
      {lane.delta ? (
        <dl class="mangle-counts">
          {countRows(lane.delta).map((row) => (
            <div key={row.verdict} class={`mangle-count mangle-count-${row.verdict}`}>
              <dt>{row.label}</dt>
              <dd data-testid={TID.mangleCount(who, row.verdict)}>{row.count}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {lane.delta || lane.losses.length > 0 ? (
        <div class="mangle-losses">
          <h4>Lost or rewritten</h4>
          {lane.losses.length === 0 ? (
            <p class="mangle-muted">No part was lost or rewritten.</p>
          ) : (
            <ul>
              {lane.losses.map((item, index) => (
                <li key={index} class={`mangle-loss mangle-loss-${item.kind}`}>
                  <span>{item.label}</span>
                  {item.members.length > 0 ? <code>{item.members.join(", ")}</code> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function stateLabel(state: LaneView["state"]): string {
  switch (state) {
    case "idle":
      return "Not run";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Did not complete";
  }
}

function LanePreview({
  plan,
  resolve,
  alt,
}: {
  plan: PreviewPlan;
  resolve: (plan: PreviewPlan) => Promise<Uint8Array<ArrayBuffer>>;
  alt: string;
}) {
  const [view, setView] = useState<{ url: string } | { message: string }>(
    plan.kind === "none" ? { message: plan.reason } : { message: "Loading the page." },
  );
  useEffect(() => {
    if (plan.kind === "none") {
      setView({ message: plan.reason });
      return;
    }
    let url: string | null = null;
    let live = true;
    setView({ message: "Loading the page." });
    resolve(plan).then(
      (png) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
        setView({ url });
      },
      (error: unknown) => {
        if (!live) return;
        const detail = kernelErrorOf(error)?.code ?? (error instanceof Error ? error.message : String(error));
        setView({
          message: plan.kind === "open-output" ? `The engine could not open this output: ${detail}` : `The page could not be shown: ${detail}`,
        });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [plan]);
  return (
    <figure class="mangle-preview">
      {"url" in view ? <img src={view.url} alt={alt} /> : <figcaption class="mangle-muted">{view.message}</figcaption>}
    </figure>
  );
}

export const mode: LabMode = {
  id: "mangle-off",
  kind: "doc",
  title: "Mangle-Off",
  summary: "Run one edit through Wolf and a rival library, then compare what each did to the rest of the file.",
  formats: ["docx", "xlsx", "pptx"],
  Stage,
};
