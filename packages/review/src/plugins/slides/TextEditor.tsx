/**
 * In-place text editor over a shape or a table cell. Lines are paragraphs.
 * Saves on blur, Cmd/Ctrl+Enter and after an 800 ms pause; Escape closes and
 * drops what has not been saved yet.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { EditorHost } from "../../host/index.ts";
import { writeCellText, writeShapeText } from "./actions.ts";
import { BOX_CLOSE, BOX_SAVE, matches } from "./keys.ts";
import type { Box } from "./model.ts";
import { storeOf, type Editing } from "./store.ts";

const PAUSE_MS = 800;

export function TextEditor({
  host,
  editing,
  box,
  pxPerPt,
}: {
  host: EditorHost;
  editing: Editing;
  box: Box;
  pxPerPt: number;
}) {
  const store = storeOf(host);
  const initial = host.node(editing.target)?.text ?? "";
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  /** Text the document holds (last successful save). */
  const saved = useRef(initial);
  const latest = useRef(initial);
  const timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const closed = useRef(false);

  useEffect(() => {
    area.current?.focus();
    area.current?.select();
    return () => {
      clearTimeout(timer.current);
    };
  }, [editing.target]);

  function close() {
    closed.current = true;
    clearTimeout(timer.current);
    if (store.state.editing?.target === editing.target) store.set({ editing: null });
  }

  /** Save the current text; serialised so saves never overlap. */
  function save(final: boolean) {
    clearTimeout(timer.current);
    chain.current = chain.current.then(async () => {
      const text = latest.current;
      if (text === saved.current) {
        if (final) close();
        return;
      }
      setSaving(true);
      const outcome =
        editing.kind === "cell"
          ? await writeCellText(host, editing.target, text)
          : await writeShapeText(host, editing.target, text);
      setSaving(false);
      if (outcome.status === "done") {
        saved.current = text;
        if (final) close();
      }
      // Refusals stay open: the host shows the error, the text is kept.
    });
  }

  function onInput(e: Event) {
    const text = (e.currentTarget as HTMLTextAreaElement).value;
    latest.current = text;
    setValue(text);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(false), PAUSE_MS);
  }

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (matches(BOX_CLOSE.keys, e)) {
      e.preventDefault();
      close();
    } else if (matches(BOX_SAVE.keys, e)) {
      e.preventDefault();
      save(true);
    }
  }

  const k = pxPerPt;
  const height = Math.max(box.h, 40 / k);
  const fontPx = Math.max(12, Math.min(28, 14 * k));
  return (
    <div
      class="we-slides-editor"
      data-testid="slides-text-editor"
      style={{ left: `${box.x * k}px`, top: `${box.y * k}px`, width: `${Math.max(box.w, 60 / k) * k}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={area}
        class="we-slides-editor-area"
        data-testid="slides-text-input"
        aria-label={editing.kind === "cell" ? "Cell text" : "Shape text"}
        value={value}
        style={{ height: `${height * k}px`, fontSize: `${fontPx}px` }}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!closed.current) save(true);
        }}
      />
      <div class="we-slides-editor-foot">
        {saving ? "Saving" : value === saved.current ? "Saved" : "Editing"}
        {" · Cmd+Enter saves, Esc closes"}
        {editing.reason && (
          <span class="we-slides-editor-reason" data-testid="slides-text-fallback">
            {` · Editing box: ${editing.reason}`}
          </span>
        )}
      </div>
    </div>
  );
}
