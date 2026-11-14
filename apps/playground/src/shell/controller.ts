/**
 * The shell's orchestration, free of the DOM: reads the visitor's file, opens
 * it in the engine when a mode needs a snapshot, swaps the engine when the
 * visitor picks another source, and routes bus events. The Preact view
 * renders `state` and calls these methods; tests drive it directly against
 * the lab fakes.
 */
import {
  createLabBus,
  type EngineSource,
  type LabBus,
  type LabDoc,
  type LabEngine,
  type LabMode,
  type ModeDeps,
  type ModeId,
} from "../lab/index.ts";
import {
  type EngineChoice,
  initialShellState,
  kernelErrorOf,
  type ModeContext,
  modeAvailability,
  pickMode,
  type ShellAction,
  type ShellState,
  shellReducer,
  validateDrop,
} from "./logic.ts";

/** What the view hands over for a dropped or chosen file. */
export type IncomingFile = { name: string; size: number; read(): Promise<Uint8Array> };

export type ShellProps = {
  modes: LabMode[];
  deps: ModeDeps;
  /** The engine sources the engine field offers; the first is the default. */
  engines: EngineChoice[];
  /** A playground engine over `source`. Called again whenever the source changes. */
  createEngine: (source: EngineSource) => LabEngine;
  /** Mode shown before anything is picked. */
  initialMode: ModeId;
};

export class ShellController {
  readonly bus: LabBus = createLabBus();
  readonly props: ShellProps;
  #engine: LabEngine;
  #offEngine: () => void = () => {};
  #state: ShellState;
  readonly #listeners = new Set<() => void>();

  constructor(props: ShellProps) {
    this.props = props;
    const source = props.engines[0]?.source ?? {};
    this.#engine = props.createEngine(source);
    this.#state = initialShellState(this.#engine.status(), source, props.initialMode);
  }

  get state(): ShellState {
    return this.#state;
  }

  /** The playground engine in use. Replaced when the source changes. */
  get engine(): LabEngine {
    return this.#engine;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispatch(action: ShellAction): void {
    const next = shellReducer(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Wire engine and bus. Returns the teardown. */
  start(): () => void {
    this.#watchEngine();
    const offBus = this.bus.on((event) => {
      switch (event.type) {
        case "journal-changed":
          this.onDoc(event.doc);
          return;
        case "toast":
          this.dispatch({ type: "toast", tone: event.tone, message: event.message });
          return;
      }
    });
    return () => {
      this.#offEngine();
      offBus();
      this.#engine.dispose();
    };
  }

  #watchEngine(): void {
    this.#offEngine();
    const engine = this.#engine;
    this.#offEngine = engine.subscribe(() => {
      if (engine === this.#engine) this.dispatch({ type: "engine", status: engine.status() });
    });
  }

  get mode(): LabMode | null {
    return this.props.modes.find((m) => m.id === this.#state.modeId) ?? null;
  }

  modeContext(): ModeContext {
    return { format: this.#state.file?.format ?? null };
  }

  /** Snapshot reports from modes. Bound so modes can pass it around. */
  readonly onDoc = (doc: LabDoc): void => {
    this.dispatch({ type: "doc", doc });
  };

  selectMode(id: ModeId): boolean {
    const mode = this.props.modes.find((m) => m.id === id);
    if (!mode || !modeAvailability(mode, this.modeContext()).available) return false;
    this.dispatch({ type: "mode", modeId: id });
    void this.#ensureDoc();
    return true;
  }

  /** Validate and read the visitor's file, then open it if the mode needs a snapshot. */
  async openOwnFile(files: IncomingFile[]): Promise<void> {
    const check = validateDrop(files);
    if (!check.ok) {
      this.dispatch({ type: "drop-rejected", message: check.message });
      return;
    }
    const incoming = files[0]!;
    const seq = this.#state.seq + 1;
    this.dispatch({ type: "pick", seq, file: { name: incoming.name, size: incoming.size, format: check.format, sha256: null } });
    try {
      // A copy on a fresh ArrayBuffer: modes and the review element may transfer it.
      const bytes = new Uint8Array(await incoming.read());
      const sha256 = await this.props.deps.verifier.sha256Hex(bytes);
      const modeId = pickMode(this.props.modes, { format: check.format }, [this.#state.modeId]);
      this.dispatch({ type: "picked", seq, picked: { name: incoming.name, bytes }, sha256, modeId });
    } catch (error) {
      this.dispatch({ type: "open-failed", seq, error: kernelErrorOf(error) });
      return;
    }
    await this.#ensureDoc();
  }

  /** Replace the engine. Snapshots of the old one are dropped and the picked
   * file is opened again if the mode needs it. */
  async setEngineSource(source: EngineSource): Promise<void> {
    const old = this.#engine;
    this.#engine = this.props.createEngine(source);
    this.#watchEngine();
    old.dispose();
    this.dispatch({ type: "source", source, status: this.#engine.status() });
    await this.#ensureDoc();
  }

  /** Load the engine now, so a failure shows before a file is picked. */
  async loadEngine(): Promise<void> {
    const engine = this.#engine;
    try {
      await engine.load();
    } catch (error) {
      if (engine !== this.#engine) return;
      const failure = kernelErrorOf(error);
      this.dispatch({ type: "toast", tone: "error", message: `The engine did not load: ${failure.code}. ${failure.message}` });
    }
  }

  /** Open the picked file in the engine when the current mode works on a
   * snapshot and none is open or opening. */
  async #ensureDoc(): Promise<void> {
    const { picked, doc, phase, seq } = this.#state;
    if (this.mode?.kind !== "doc" || !picked || doc || phase === "opening" || phase === "reading") return;
    const engine = this.#engine;
    this.dispatch({ type: "open-start", seq });
    try {
      const opened = await engine.openFile(picked.bytes, picked.name);
      // The engine was replaced meanwhile: its snapshot is gone with it.
      if (engine !== this.#engine) return;
      this.dispatch({ type: "opened", seq, doc: opened });
    } catch (error) {
      if (engine !== this.#engine) return;
      this.dispatch({ type: "open-failed", seq, error: kernelErrorOf(error) });
    }
  }
}
