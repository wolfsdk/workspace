import { useEffect, useRef, useState } from "preact/hooks";
import type { KernelError } from "@wolfsdk/protocol";
import type { FaceInfo, UsedFace } from "@wolfsdk/runtime/vector";
import { useDismiss, useFocusTrap } from "./chrome.tsx";
import { Icon } from "./icons.tsx";
import { toKernelError } from "./util.ts";
import type { LicenceText, VectorDoc, VectorPages } from "./vector.ts";

type Row = {
  handle: string;
  family: string;
  requested: string[];
  /** `document` (carried by the file), `bundled` (compiled into the module) or `unknown`. */
  origin: UsedFace["origin"];
  bundled: UsedFace["bundled"];
};

function fromUsed(face: UsedFace): Row {
  return {
    handle: face.handle,
    family: face.family,
    requested: face.requested,
    origin: face.origin,
    bundled: face.bundled,
  };
}

function fromInfo(face: FaceInfo): Row {
  const origin = face.embeddedInDocument ? "document" : face.bundled ? "bundled" : "unknown";
  return {
    handle: face.face,
    family: face.family,
    requested: [],
    origin,
    bundled: face.embeddedInDocument ? null : face.bundled,
  };
}

/**
 * Fonts and licences of the open document: the faces drawn on the pages shown
 * so far (`ResourceCache.usedFaces`) with the module's licence entry, then the
 * document's other faces (`fonts`). Licence text comes from the module
 * (`resource` of the face's `license_file`); a module that does not serve it
 * answers `unknown-resource`, shown as a plain note with the licence name and
 * upstream link.
 */
export function FontsSheet({ vector, vdoc, onClose }: { vector: VectorPages; vdoc: VectorDoc; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<{ used: Row[]; other: Row[] } | null>(null);
  const [error, setError] = useState<KernelError | null>(null);
  const [texts, setTexts] = useState<Record<string, LicenceText | "loading">>({});

  useEffect(() => {
    const previous = (panel.current?.getRootNode() as Document | ShadowRoot | undefined)
      ?.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useDismiss(true, panel, onClose);
  useFocusTrap(panel);

  useEffect(() => {
    let live = true;
    vdoc.fonts().then(
      (faces) => {
        if (!live) return;
        const used = vdoc.usedFaces().map(fromUsed);
        const drawn = new Set(used.map((r) => r.handle));
        const other = faces.filter((f) => !drawn.has(f.face)).map(fromInfo);
        const byFamily = (a: Row, b: Row) => a.family.localeCompare(b.family);
        setRows({ used: used.sort(byFamily), other: other.sort(byFamily) });
      },
      (cause) => live && setError(toKernelError(cause)),
    );
    return () => {
      live = false;
    };
  }, [vdoc]);

  function showLicence(path: string) {
    setTexts((t) => ({ ...t, [path]: "loading" }));
    void vector.licence(path).then((text) => setTexts((t) => ({ ...t, [path]: text })));
  }

  const renderRow = (row: Row, index: number, group: string) => {
    const b = row.bundled;
    const text = b?.licenseFile ? texts[b.licenseFile] : undefined;
    return (
      <li key={row.handle} class="we-shell-font" data-testid={`shell-fonts-${group}-${index}`}>
        <div class="we-shell-font-head">
          <strong>{row.family || "Unnamed face"}</strong>
          {b?.file && <span class="we-shell-muted">{b.file.split("/").pop()}</span>}
          <span
            class={`we-chip we-shell-font-origin${row.origin === "unknown" ? "" : " we-chip--info"}`}
            data-testid={`shell-fonts-${group}-${index}-origin`}
            data-origin={row.origin}
          >
            {row.origin === "document"
              ? "From the document"
              : row.origin === "bundled"
                ? "Bundled with the engine"
                : "Origin unknown"}
          </span>
          {row.requested.some((r) => r !== row.family) && (
            <span class="we-shell-muted">for {row.requested.filter((r) => r !== row.family).join(", ")}</span>
          )}
        </div>
        <div class="we-shell-font-licence">
          {b ? (
            <>
              <span data-testid={`shell-fonts-${group}-${index}-licence`}>{b.license || "licence not named"}</span>
              {b.version && <span class="we-shell-muted">version {b.version}</span>}
              {b.upstreamUrl && (
                <a href={b.upstreamUrl} target="_blank" rel="noopener noreferrer" title={b.upstreamUrl}>
                  Upstream file
                </a>
              )}
              {b.licenseFile && text === undefined && (
                <button
                  class="we-btn we-btn--small"
                  title={`Show the licence text (${b.licenseFile})`}
                  aria-label={`Show the licence text of ${row.family}`}
                  data-testid={`shell-fonts-${group}-${index}-text`}
                  onClick={() => showLicence(b.licenseFile)}
                >
                  Licence text
                </button>
              )}
            </>
          ) : row.origin === "document" ? (
            <span>Embedded in the document</span>
          ) : (
            <span class="we-shell-muted">Origin unknown: no licence entry from the engine</span>
          )}
        </div>
        {text === "loading" && <div class="we-shell-muted">Loading licence text...</div>}
        {text &&
          text !== "loading" &&
          (text.ok ? (
            <pre class="we-shell-font-text" data-testid={`shell-fonts-${group}-${index}-body`}>
              {text.text}
            </pre>
          ) : (
            <div class="we-shell-muted" data-testid={`shell-fonts-${group}-${index}-unavailable`}>
              {text.error.code === "unknown-resource"
                ? `Licence text unavailable in this module build (${b?.licenseFile}).`
                : `Licence text unavailable: ${text.error.code} ${text.error.message}`}
            </div>
          ))}
      </li>
    );
  };

  return (
    <div class="we-shell-scrim">
      <div
        class="we-shell-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="we-shell-fonts-title"
        data-testid="shell-fonts"
        ref={panel}
      >
        <div class="we-shell-sheet-head">
          <h2 id="we-shell-fonts-title">Fonts and licences</h2>
          <button
            ref={closeBtn}
            class="we-btn we-btn--icon we-btn--small"
            title="Close (Escape)"
            aria-label="Close fonts and licences"
            data-testid="shell-fonts-close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {error && (
          <div class="we-notice we-notice--error" role="alert">
            <strong>{error.code}</strong> {error.message}
          </div>
        )}
        {!rows && !error && <p class="we-shell-muted">Reading the document's fonts...</p>}
        {rows && (
          <>
            <h3 class="we-shell-font-group">Drawn on the pages shown</h3>
            {rows.used.length ? (
              <ul class="we-shell-font-list" data-testid="shell-fonts-used">
                {rows.used.map((r, i) => renderRow(r, i, "used"))}
              </ul>
            ) : (
              <p class="we-shell-muted">No vector page has been drawn yet.</p>
            )}
            {rows.other.length > 0 && (
              <>
                <h3 class="we-shell-font-group">Other faces in this document</h3>
                <ul class="we-shell-font-list" data-testid="shell-fonts-other">
                  {rows.other.map((r, i) => renderRow(r, i, "other"))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
