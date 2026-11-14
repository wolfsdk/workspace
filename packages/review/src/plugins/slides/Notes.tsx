/**
 * Speaker notes of the current slide, in the `BelowCanvas` region: a header
 * line (collapse toggle), a top-edge splitter and the notes text. Height and
 * collapsed state live in the plugin store for the session. Notes are saved
 * with paragraph-level edits when the engine has them, else `replace-text`
 * plus paragraph insert; slides without a notes part cannot get one.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useEditor, type PluginProps } from "../../host/index.ts";
import { writeNotes } from "./actions.ts";
import { deckOf, isCut } from "./model.ts";
import { useSlides } from "./store.ts";

const PAUSE_MS = 800;
const MIN_HEIGHT = 40;
const STEP = 16;
/** The notes may take at most this share of the viewport. */
const MAX_SHARE = 0.6;

const maxHeight = () => Math.max(MIN_HEIGHT, Math.round(window.innerHeight * MAX_SHARE));
const clampHeight = (h: number) => Math.max(MIN_HEIGHT, Math.min(maxHeight(), Math.round(h)));

export function SlidesNotes({ host }: PluginProps) {
  const snap = useEditor(host);
  const [ui, store] = useSlides(host);
  const state = snap.state;
  const slide = state && state.format === "pptx" ? deckOf(state).byPage.get(snap.currentPage) : undefined;
  const text = slide?.notes?.text ?? "";
  const [value, setValue] = useState(text);
  const [dirty, setDirty] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(text);
  const slideId = slide?.id;
  /** Slide the pending text belongs to (the user may navigate before it saves). */
  const owner = useRef<string | undefined>(slideId);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  // Follow the document while the user is not typing.
  useEffect(() => {
    if (!dirty) {
      setValue(text);
      latest.current = text;
    }
  }, [slideId, text]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!state || state.format !== "pptx" || !slide) return null;
  const editable = !!slide.notes && !isCut(text);
  const pane = ui.notesPane;
  const height = clampHeight(pane.height);
  const setPane = (patch: Partial<typeof pane>) => store.set({ notesPane: { ...store.state.notesPane, ...patch } });

  async function save() {
    clearTimeout(timer.current);
    const current = host.getSnapshot().state;
    const target = current && owner.current ? deckOf(current).bySlide.get(owner.current) : undefined;
    if (!target?.notes || latest.current === (target.notes.text ?? "")) {
      setDirty(false);
      return;
    }
    const ok = await writeNotes(host, target, latest.current);
    setDirty(false);
    // A refused edit is reported by the host; show the document's text again.
    if (!ok) setValue(target.notes.text ?? "");
  }

  const onSplitterKey = (e: KeyboardEvent) => {
    const next =
      e.key === "ArrowUp"
        ? height + STEP
        : e.key === "ArrowDown"
          ? height - STEP
          : e.key === "Home"
            ? MIN_HEIGHT
            : e.key === "End"
              ? maxHeight()
              : null;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      setPane({ collapsed: true });
      return;
    }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPane({ height: clampHeight(next) });
  };

  const notesId = `we-slides-notes-body-${slideId ?? ""}`;
  return (
    <section
      class={`we-slides-notes${pane.collapsed ? " is-collapsed" : ""}`}
      data-testid="slides-notes"
      aria-label="Speaker notes"
    >
      {!pane.collapsed && (
        <div
          class="we-slides-notes-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize speaker notes"
          aria-controls={notesId}
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={maxHeight()}
          aria-valuenow={height}
          title="Drag or use Up / Down to resize the notes; Enter collapses them"
          tabIndex={0}
          data-testid="slides-notes-splitter"
          onKeyDown={onSplitterKey}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { startY: e.clientY, startH: height };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setPane({ height: clampHeight(d.startH + d.startY - e.clientY) });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        />
      )}
      <div class="we-slides-notes-head">
        <button
          type="button"
          class="we-btn we-btn--small we-slides-notes-toggle"
          data-testid="slides-notes-toggle"
          title={pane.collapsed ? "Show speaker notes" : "Hide speaker notes"}
          aria-label={pane.collapsed ? "Show speaker notes" : "Hide speaker notes"}
          aria-expanded={!pane.collapsed}
          aria-controls={notesId}
          onClick={() => setPane({ collapsed: !pane.collapsed })}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d={pane.collapsed ? "M4.5 9.5 8 6l3.5 3.5" : "M4.5 6.5 8 10l3.5-3.5"} />
          </svg>
          Notes
        </button>
        <span class="we-slides-notes-title" data-testid="slides-notes-title">
          Slide {slide.page}
          {pane.collapsed && editable && text ? `: ${text.split("\n")[0]}` : ""}
        </span>
      </div>
      {!pane.collapsed && (
        <div class="we-slides-notes-body" id={notesId} style={{ height: `${height}px` }}>
          {editable ? (
            <textarea
              class="we-input we-slides-notes-input"
              data-testid="slides-notes-input"
              aria-label={`Speaker notes for slide ${slide.page}`}
              value={value}
              onInput={(e) => {
                const next = (e.currentTarget as HTMLTextAreaElement).value;
                latest.current = next;
                owner.current = slide.id;
                setValue(next);
                setDirty(true);
                clearTimeout(timer.current);
                timer.current = window.setTimeout(() => void save(), PAUSE_MS);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
              onBlur={() => void save()}
            />
          ) : (
            <p class="we-slides-muted" data-testid="slides-notes-none">
              {slide.notes
                ? "These notes are cut in the engine view and cannot be edited here."
                : "This slide has no notes part. The engine edits existing notes only and cannot add one."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
