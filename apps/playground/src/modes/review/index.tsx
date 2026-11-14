/** @jsxImportSource preact */
/**
 * Review mode: the published `<wolf-review>` element, mounted as an embedder
 * would mount it. The shell's engine source and picked file go in through the
 * element's own API; everything the element reports comes back through its
 * events and is listed beside it.
 */
import "@wolfsdk/review/auto";
import type { WolfMode, WolfReviewElement, WolfReviewEventMap } from "@wolfsdk/review";
import { useEffect, useRef, useState } from "preact/hooks";
import { type LabMode, type SurfaceProps, TID } from "../../lab/index.ts";
import "./review.css";

type LogLine = { n: number; event: keyof WolfReviewEventMap; text: string; code?: string };

const EVENTS: (keyof WolfReviewEventMap)[] = [
  "wolf-ready",
  "wolf-open",
  "wolf-change",
  "wolf-save",
  "wolf-error",
  "wolf-selection",
  "wolf-review-submit",
  "wolf-review-agent-activity",
];

/** Keep the log short: the newest lines are the ones a visitor reads. */
const LOG_LIMIT = 200;

/** One event of the element, with the detail its event map gives it. */
export type ElementEvent = {
  [K in keyof WolfReviewEventMap]: { name: K; detail: WolfReviewEventMap[K]["detail"] };
}[keyof WolfReviewEventMap];

/** One line of the event log, from the event's own detail. */
export function describeEvent(e: ElementEvent): string {
  switch (e.name) {
    case "wolf-ready":
      return `Engine ready: ${e.detail.moduleUrl}`;
    case "wolf-open": {
      const d = e.detail;
      return `Opened ${d.name} (${d.format}, ${d.pages === 1 ? "1 page" : `${d.pages} pages`}), sha256 ${d.sha256}`;
    }
    case "wolf-change": {
      const d = e.detail;
      const ops = d.ops.length === 1 ? "1 op" : `${d.ops.length} ops`;
      return `Revision ${d.revision} from ${d.source}, ${ops}, sha256 ${d.sha256}`;
    }
    case "wolf-save":
      return `Saved ${e.detail.name}, ${e.detail.bytes.byteLength} bytes, sha256 ${e.detail.sha256}`;
    case "wolf-error":
      return `${e.detail.code}: ${e.detail.message}`;
    case "wolf-selection":
      return e.detail.addresses.length === 0 ? "Selection cleared" : `Selected ${e.detail.addresses.join(", ")}`;
    case "wolf-review-submit": {
      const d = e.detail;
      const s = d.decision.summary;
      return `Review submitted for ${d.name}: ${s.approve} approved, ${s.reject} rejected, ${s.undecided} undecided, sha256 ${d.sha256}`;
    }
    case "wolf-review-agent-activity":
      return e.detail.agents.length === 0
        ? "Agent activity cleared"
        : `Agents active: ${e.detail.agents.map((a) => `${a.display_name} (${a.activity})`).join(", ")}`;
  }
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Stage({ file, engine }: SurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<WolfReviewElement | null>(null);
  const [mode, setMode] = useState<WolfMode>("edit");
  const [log, setLog] = useState<LogLine[]>([]);
  const [opened, setOpened] = useState<string | null>(null);

  // One element for the life of the stage, as a page would embed it.
  useEffect(() => {
    const el = document.createElement("wolf-review");
    el.setAttribute("data-testid", TID.reviewElement);
    el.setAttribute("unload-guard", "");
    // Before it connects, so it starts on the chosen engine and not on the release channel.
    el.engine = engine;
    let n = 0;
    const offs = EVENTS.map((name) => {
      const listener = (event: Event) => {
        // The element dispatches `name` only as the CustomEvent its event map gives it.
        const e = { name, detail: (event as CustomEvent).detail } as ElementEvent;
        const line: LogLine = { n: n++, event: name, text: describeEvent(e) };
        if (e.name === "wolf-error") line.code = e.detail.code;
        if (e.name === "wolf-open") setOpened(e.detail.name);
        setLog((prev) => [line, ...prev].slice(0, LOG_LIMIT));
      };
      el.addEventListener(name, listener);
      return () => el.removeEventListener(name, listener);
    });
    host.current!.append(el);
    setElement(el);
    return () => {
      for (const off of offs) off();
      el.remove();
    };
  }, []);

  useEffect(() => {
    if (element) element.engine = engine;
  }, [element, engine]);

  useEffect(() => {
    element?.setAttribute("mode", mode);
  }, [element, mode]);

  useEffect(() => {
    if (!element || !file) return;
    setOpened(null);
    // The element reports a refusal as `wolf-error`; the rejection repeats it.
    // A copy: the element may hand its buffer to the engine worker, and the
    // other modes still read the picked bytes.
    element.open(file.bytes.slice(), file.name).catch(() => undefined);
  }, [element, file, engine]);

  const saveBytes = async () => {
    if (!element || !opened) return;
    const bytes = await element.save();
    // BlobPart wants an ArrayBuffer-backed view; copy only if the bytes sit on a shared buffer.
    const own = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
    download(opened, own, "application/octet-stream");
  };
  const saveSession = async () => {
    if (!element || !opened) return;
    download(`${opened}.session.json`, `${JSON.stringify(await element.session(), null, 2)}\n`, "application/json");
  };

  return (
    <div class="review">
      <div class="review-bar">
        <p class="review-lede">
          {file
            ? "This is the review element as a page embeds it. Edit, undo and redo here; every event it raises is listed below."
            : "This is the review element as a page embeds it. Drop a file above, or use the element's own picker."}
        </p>
        <label class="review-mode">
          Element mode{" "}
          <select value={mode} onChange={(event) => setMode(event.currentTarget.value as WolfMode)}>
            <option value="edit">Edit</option>
            <option value="review">Review</option>
          </select>
        </label>
        <button
          type="button"
          class="lab-button lab-button--small"
          data-testid={TID.reviewDownloadBytes}
          disabled={!opened}
          onClick={() => void saveBytes()}
        >
          Download the current file
        </button>
        <button
          type="button"
          class="lab-button lab-button--small"
          data-testid={TID.reviewDownloadSession}
          disabled={!opened}
          onClick={() => void saveSession()}
        >
          Download the session log
        </button>
      </div>
      <div class="review-host" ref={host} />
      <section class="review-log" aria-labelledby="review-log-title">
        <h3 id="review-log-title">Element events</h3>
        {log.length === 0 ? (
          <p>No events yet.</p>
        ) : (
          <ol data-testid={TID.reviewLog} reversed>
            {log.map((line) => (
              <li key={line.n} data-event={line.event} data-code={line.code}>
                <code>{line.event}</code> {line.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export const mode: LabMode = {
  id: "review",
  title: "Review",
  summary: "Open the file in the review element, edit or review it, and watch the events it raises.",
  formats: ["docx", "xlsx", "pptx"],
  kind: "surface",
  Stage,
};
