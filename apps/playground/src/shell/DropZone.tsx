import { TID } from "../lab/index.ts";
import { useRef, useState } from "preact/hooks";
import type { IncomingFile } from "./controller.ts";
import { formatBytes } from "../anatomy/index.ts";
import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES, type OwnFile } from "./logic.ts";

const ACCEPT = [
  ...ACCEPTED_EXTENSIONS,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

/** Files from a drop or a file input, read lazily. */
export const incomingFiles = (list: FileList | null | undefined): IncomingFile[] =>
  [...(list ?? [])].map((file) => ({
    name: file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  }));

export function DropZone({
  file,
  active,
  error,
  onFiles,
}: {
  file: OwnFile | null;
  /** True while the visitor's file is the open document. */
  active: boolean;
  error: string | null;
  onFiles: (files: IncomingFile[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hold = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  return (
    <section
      class="lab-drop"
      data-testid={TID.dropZone}
      data-over={String(over)}
      data-active={String(active)}
      aria-labelledby="lab-drop-title"
      onDragEnter={hold}
      onDragOver={hold}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        onFiles(incomingFiles(event.dataTransfer?.files));
      }}
    >
      <h2 id="lab-drop-title" class="lab-drop__title">
        Your own file
      </h2>
      <p class="lab-drop__hint">
        Drop a file to inspect it, or choose one. Accepts .docx, .xlsx and .pptx files up to{" "}
        {formatBytes(MAX_FILE_BYTES)}.
      </p>
      <button type="button" class="lab-button" onClick={() => input.current?.click()}>
        Choose a file
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        class="lab-visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={TID.dropInput}
        onChange={(event) => {
          const target = event.currentTarget;
          onFiles(incomingFiles(target.files));
          target.value = "";
        }}
      />
      {error && (
        <p class="lab-alert" role="alert">
          {error}
        </p>
      )}
      {file && (
        <dl class="lab-facts">
          <dt>Name</dt>
          <dd>{file.name}</dd>
          <dt>Size</dt>
          <dd>
            {formatBytes(file.size)}
            {file.size >= 1024 && ` (${file.size} bytes)`}
          </dd>
          <dt>sha256</dt>
          <dd>
            <code class="lab-hash">{file.sha256 ?? "Computing"}</code>
          </dd>
        </dl>
      )}
    </section>
  );
}
