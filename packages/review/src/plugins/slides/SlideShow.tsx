/** Full-screen presenter: page images, arrow keys to step, Escape to leave. */
import { dispatch, SHOW_KEYS, type ShowActions } from "./keys.ts";
import { useEffect, useRef, useState } from "preact/hooks";
import { useEditor, type EditorHost } from "../../host/index.ts";

export function SlideShow({ host, start, onClose }: { host: EditorHost; start: number; onClose: () => void }) {
  const snap = useEditor(host);
  const pages = snap.state?.pages ?? [];
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      pages.findIndex((p) => p.page === start),
    ),
  );
  const [url, setUrl] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const info = pages[index];
  const revision = snap.state ? `${snap.state.doc}:${snap.state.sha256}` : "";

  useEffect(() => {
    const el = root.current;
    el?.focus();
    // Full screen when the browser allows it; the fixed layer covers the page
    // otherwise. Inside a shadow root `document.fullscreenElement` is the
    // shadow host, so ask the element's own root.
    const tree = el?.getRootNode() as Document | ShadowRoot | undefined;
    el?.requestFullscreen?.().catch(() => {});
    const onChange = () => {
      if (!tree?.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (el && tree?.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!info) return;
    let live = true;
    host.pageImageUrl(info.page, info.dpi / 72).then(
      (u) => live && setUrl(u),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [info?.page, revision]);

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const last = pages.length - 1;
    const actions: ShowActions = {
      step: (by) => setIndex((i) => Math.max(0, Math.min(last, i + by))),
      edge: (end) => setIndex(end ? last : 0),
      close: onClose,
    };
    if (dispatch(SHOW_KEYS, actions, e)) e.preventDefault();
  }

  return (
    <div
      ref={root}
      class="we-slides-show"
      data-testid="slides-show-view"
      role="dialog"
      aria-label="Slide show"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={() => setIndex((i) => Math.min(pages.length - 1, i + 1))}
    >
      {url && info && (
        <img class="we-slides-show-img" src={url} alt={`Slide ${info.page}`} data-testid="slides-show-image" />
      )}
      <div class="we-slides-show-bar">
        <span data-testid="slides-show-counter">
          {index + 1} / {pages.length}
        </span>
        <button
          type="button"
          class="we-slides-show-exit"
          data-testid="slides-show-exit"
          title="End slide show (Esc)"
          aria-label="End slide show"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          End show
        </button>
      </div>
    </div>
  );
}
