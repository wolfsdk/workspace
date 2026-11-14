/** @jsxImportSource preact */
import { TID, type CodeDrawerProps, type Journal } from "../lab/index.ts";
import { useId, useMemo, useRef, useState } from "preact/hooks";
import { BATCH_FILE, batchesJson, toCli, toMcp, toPython, toTypeScript } from "./emit.ts";
import "./code-drawer.css";

type Kind = Parameters<typeof TID.codeTab>[0];

const TABS: { kind: Kind; label: string; file: string; type: string; emit: (journal: Journal) => string }[] = [
  { kind: "batches", label: "Batches", file: BATCH_FILE, type: "application/json", emit: batchesJson },
  { kind: "cli", label: "Shell", file: "replay.sh", type: "text/x-shellscript", emit: toCli },
  { kind: "python", label: "Python", file: "replay.py", type: "text/x-python", emit: toPython },
  { kind: "mcp", label: "MCP", file: "wolf-mcp-calls.json", type: "application/json", emit: toMcp },
  { kind: "typescript", label: "TypeScript", file: "replay.ts", type: "text/plain", emit: toTypeScript },
];

export function CodeDrawer({ journal }: CodeDrawerProps) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState("");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const texts = useMemo(() => TABS.map((tab) => tab.emit(journal)), [journal]);
  const tab = TABS[selected]!;
  const text = texts[selected]!;
  const { clock, timezone, locale, seed } = journal.environment;
  const appliedCount = journal.entries.filter((e) => e.status === "applied").length;

  const select = (index: number, focus: boolean) => {
    setSelected(index);
    setNotice("");
    if (focus) tabRefs.current[index]?.focus();
  };

  const onTabKey = (event: KeyboardEvent, index: number) => {
    const last = TABS.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${tab.file} to the clipboard.`);
    } catch {
      setNotice("Copy did not work here. Select the text and copy it by hand.");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: tab.type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = tab.file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(`Saved ${tab.file}.`);
  };

  return (
    <section class="lab-code" aria-labelledby={`${id}-title`}>
      <h2 class="lab-code__title" id={`${id}-title`}>
        Replay this document outside the playground
      </h2>
      <p class="lab-code__meta">
        {appliedCount} of {journal.entries.length} steps replay. Rejected and conflicted steps are left out.
      </p>
      <p class="lab-code__meta">
        Pinned environment: clock {clock}, time zone {timezone}, locale {locale}, seed {seed}.{" "}
        {journal.engine
          ? `Recorded with engine ${journal.engine.version === null ? "module" : `version ${journal.engine.version}`}, module sha256 ${journal.engine.moduleSha256}.`
          : "No engine build is recorded for this journal."}
      </p>
      <div class="lab-code__tabs" role="tablist" aria-label="Replay format">
        {TABS.map((t, index) => (
          <button
            key={t.kind}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            class="lab-code__tab"
            id={`${id}-tab-${t.kind}`}
            aria-selected={index === selected}
            aria-controls={`${id}-panel`}
            tabIndex={index === selected ? 0 : -1}
            data-testid={TID.codeTab(t.kind)}
            onClick={() => select(index, false)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div class="lab-code__panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab.kind}`}>
        <div class="lab-code__actions">
          <span class="lab-code__file">{tab.file}</span>
          <button type="button" class="lab-code__action" onClick={copy}>
            Copy
          </button>
          <button type="button" class="lab-code__action" onClick={download}>
            Download {tab.file}
          </button>
        </div>
        <pre class="lab-code__text" tabIndex={0} aria-label={`${tab.label} replay code`} data-testid={TID.codeText}>
          {text}
        </pre>
        <p class="lab-code__notice" role="status" aria-live="polite">
          {notice}
        </p>
      </div>
    </section>
  );
}
