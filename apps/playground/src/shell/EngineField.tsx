import { type EngineSource, type EngineStatus, TID } from "../lab/index.ts";
import { useState } from "preact/hooks";
import { describeSource, type EngineChoice, engineChip } from "./logic.ts";

const CUSTOM = "custom";

/**
 * Which engine module the page runs, and its state. The same source drives
 * the playground's own engine and the review element. A custom module URL
 * may carry the sha256 the module must have.
 */
export function EngineField({
  status,
  source,
  choices,
  onSource,
  onLoad,
}: {
  status: EngineStatus;
  source: EngineSource;
  choices: EngineChoice[];
  onSource: (source: EngineSource) => void;
  onLoad: () => void;
}) {
  const chip = engineChip(status);
  const current = choices.find((c) => c.source === source)?.id ?? CUSTOM;
  const [picked, setPicked] = useState(current);
  const [url, setUrl] = useState(source.url !== undefined ? String(source.url) : "");
  const [sha256, setSha256] = useState(source.sha256 ?? "");

  const submit = (event: Event) => {
    event.preventDefault();
    const choice = choices.find((c) => c.id === picked);
    if (choice) {
      if (choice.source !== source) onSource(choice.source);
      return;
    }
    const trimmed = url.trim();
    if (trimmed === "") return;
    const next: EngineSource = { url: trimmed };
    const hash = sha256.trim().toLowerCase();
    if (hash !== "") next.sha256 = hash;
    onSource(next);
  };

  return (
    <div
      class="lab-chip lab-engine"
      data-testid={TID.engineStatus}
      data-phase={status.phase}
      data-code={status.error?.code}
      data-loading={String(chip.loading)}
    >
      <span class="lab-chip__label">
        <span class="lab-mark" aria-hidden="true">
          {status.phase === "ready" ? "●" : "○"}
        </span>{" "}
        {chip.label}
      </span>
      <span class="lab-chip__detail">{chip.detail}</span>
      {chip.loading && <progress class="lab-progress" aria-label="Engine module download" />}
      {status.error && <span class="lab-chip__error">{status.error.message}</span>}
      {status.phase === "idle" && !chip.loading && (
        <button type="button" class="lab-button lab-button--small" onClick={onLoad}>
          Load now
        </button>
      )}
      <form class="lab-engine__form" data-testid={TID.engineField} onSubmit={submit}>
        <label class="lab-engine__label">
          Engine{" "}
          <select value={picked} onChange={(event) => setPicked(event.currentTarget.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            <option value={CUSTOM}>Module URL</option>
          </select>
        </label>
        {picked === CUSTOM && (
          <>
            <label class="lab-engine__label">
              URL{" "}
              <input
                type="url"
                required
                data-testid={TID.engineUrl}
                value={url}
                onInput={(event) => setUrl(event.currentTarget.value)}
              />
            </label>
            <label class="lab-engine__label">
              sha256{" "}
              <input
                type="text"
                pattern="[0-9a-fA-F]{64}"
                placeholder="optional"
                value={sha256}
                onInput={(event) => setSha256(event.currentTarget.value)}
              />
            </label>
          </>
        )}
        <button type="submit" class="lab-button lab-button--small">
          Use this engine
        </button>
      </form>
      <span class="lab-chip__detail">{describeSource(source)}</span>
    </div>
  );
}
