/** @jsxImportSource preact */
// Left rail: the room, its documents (with upload), and the linked pack.
import { useEffect, useRef, useState } from "preact/hooks";
import type { PackStatus, RoomRow } from "../lib/api.ts";
import type { DocumentSummary } from "../lib/room-state.ts";
import { roomIdFrom } from "../lib/session.ts";
import { EmptyState, FormatPill, Icon, Time } from "./common.tsx";

export type LeftRailProps = {
  rooms: RoomRow[];
  roomId: string | null;
  documents: DocumentSummary[];
  activeDoc: string | null;
  pack: PackStatus | null;
  packBusy: boolean;
  uploading: string | null;
  onSelectRoom(roomId: string): void;
  onCreateRoom(roomId: string): Promise<boolean>;
  onSelectDoc(name: string): void;
  onUpload(files: File[]): void;
  onDownloadHead(name: string): void;
  onRefreshPack(): void;
};

export function LeftRail(props: LeftRailProps) {
  return (
    <nav class="rail rail--left" aria-label="Rooms and documents">
      <RoomSection {...props} />
      <DocumentSection {...props} />
      {props.pack ? (
        <PackCard pack={props.pack} roomId={props.roomId} documents={props.documents} busy={props.packBusy} onRefresh={props.onRefreshPack} />
      ) : null}
    </nav>
  );
}

function RoomSection({ rooms, roomId, onSelectRoom, onCreateRoom }: LeftRailProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const id = roomIdFrom(name);
  return (
    <section class="rail-section">
      <header class="rail-heading">
        <h2>Room</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="New room"
          aria-expanded={creating}
          title="New room"
          onClick={() => setCreating(!creating)}
        >
          <Icon name="plus" />
        </button>
      </header>
      {rooms.length === 0 && !creating ? (
        <EmptyState title="No rooms yet">
          <button type="button" class="button button--small" onClick={() => setCreating(true)}>
            Create a room
          </button>
        </EmptyState>
      ) : (
        <label class="select">
          <span class="visually-hidden">Active room</span>
          <select value={roomId ?? ""} onChange={(e) => onSelectRoom(e.currentTarget.value)} disabled={rooms.length === 0}>
            {rooms.map((room) => (
              <option key={room.room_id} value={room.room_id}>
                {room.room_id}
              </option>
            ))}
          </select>
        </label>
      )}
      {creating ? (
        <form
          class="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (id === "") return;
            if (await onCreateRoom(id)) {
              setName("");
              setCreating(false);
            }
          }}
        >
          <input
            class="input"
            autoFocus
            placeholder="Room name, like q3-close"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            aria-label="New room name"
          />
          {name !== "" && id !== name ? <p class="hint">Saved as {id === "" ? "an empty id" : id}</p> : null}
          <div class="inline-actions">
            <button type="button" class="button button--quiet button--small" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" class="button button--primary button--small" disabled={id === ""}>
              Create room
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function DocumentSection({ roomId, documents, activeDoc, uploading, onSelectDoc, onUpload, onDownloadHead }: LeftRailProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const drop = (files: FileList | null | undefined): void => {
    if (files && files.length > 0) onUpload([...files]);
  };
  return (
    <section
      class={`rail-section rail-section--grow${dragging ? " is-dragging" : ""}`}
      onDragOver={(e) => {
        if (roomId === null) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        drop(e.dataTransfer?.files);
      }}
    >
      <header class="rail-heading">
        <h2>Documents</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Upload documents"
          title="Upload documents"
          disabled={roomId === null}
          onClick={() => input.current?.click()}
        >
          <Icon name="upload" />
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".docx,.xlsx,.pptx,.pdf"
          onChange={(e) => {
            drop(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
      </header>
      {uploading ? <p class="hint hint--progress">Uploading {uploading}</p> : null}
      {documents.length === 0 ? (
        <EmptyState title={roomId === null ? "Pick a room to see its documents" : "This room has no documents"}>
          {roomId === null ? null : <p>Drop a DOCX, XLSX, PPTX or PDF file here, or click Upload.</p>}
        </EmptyState>
      ) : (
        <ul class="doc-list" role="listbox" aria-label="Documents">
          {documents.map((doc) => (
            <li
              key={doc.name}
              class={`doc-row${doc.name === activeDoc ? " is-active" : ""}`}
              role="option"
              aria-selected={doc.name === activeDoc}
            >
              <button type="button" class="doc-main" onClick={() => onSelectDoc(doc.name)}>
                <FormatPill format={doc.format} />
                <span class="doc-name" title={doc.name}>
                  {doc.name}
                </span>
                <span class="doc-meta">
                  <span class="badge" title={`Revision ${doc.revision}`}>
                    r{doc.revision}
                  </span>
                  {doc.openProposals > 0 ? (
                    <span class="badge badge--accent" title={`${doc.openProposals} open proposals`}>
                      {doc.openProposals}
                    </span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                class="icon-button doc-download"
                aria-label={`Download head of ${doc.name}`}
                title="Download head"
                onClick={() => onDownloadHead(doc.name)}
              >
                <Icon name="download" size={14} />
              </button>
              <span class="doc-updated">
                Updated <Time at={doc.updated_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {dragging ? <div class="drop-hint">Drop to add to {roomId}</div> : null}
    </section>
  );
}

const BINDING_TONE = { fresh: "success", stale: "warning", refreshed: "info" } as const;

type PackCardProps = { pack: PackStatus; roomId: string | null; documents: DocumentSummary[]; busy: boolean; onRefresh(): void };

/** The pack judged against the heads of the open room, judged again whenever a head moves: a refresh that was
 * approved and committed shows its bindings fresh at once, and an edit to a source shows them stale. */
function PackCard({ pack, roomId, documents, busy, onRefresh }: PackCardProps) {
  const [status, setStatus] = useState(pack);
  const [problem, setProblem] = useState<string | null>(null);
  const heads = documents.map((d) => `${d.name}@${d.revision}`).join("\n");
  useEffect(() => {
    setStatus(pack);
  }, [pack]);
  useEffect(() => {
    const reload = pack.reload;
    if (reload === undefined) return;
    let current = true;
    reload(roomId).then(
      (next) => {
        if (!current || next === null) return;
        setStatus(next);
        setProblem(null);
      },
      (e: unknown) => {
        if (current) setProblem(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [pack, roomId, heads]);
  const stale = status.report.bindings.filter((b) => b.status === "stale").length;
  return (
    <section class="rail-section pack-card" aria-labelledby="pack-title">
      <header class="rail-heading">
        <h2 id="pack-title">Linked pack</h2>
        <span class={`status status--${status.report.fresh ? "success" : "warning"}`}>{status.report.fresh ? "Fresh" : `${stale} stale`}</span>
      </header>
      <p class="pack-id" title={status.room ? `${status.dir}, against the heads of ${status.room}` : status.dir}>
        {status.report.pack_id}
      </p>
      {problem === null ? null : (
        <p class="hint" role="status">
          Not checked against the room's heads: {problem}
        </p>
      )}
      <ul class="pack-bindings">
        {status.report.bindings.map((binding) => (
          <li key={binding.binding_id} title={binding.notes.join("\n") || undefined}>
            <span class={`status-dot status-dot--${BINDING_TONE[binding.status]}`} aria-hidden="true" />
            <span class="pack-binding">{binding.binding_id}</span>
            <span class="pack-target">{binding.target_doc}</span>
            <span class="visually-hidden">{binding.status}</span>
          </li>
        ))}
      </ul>
      <button type="button" class="button button--small button--block" disabled={busy} onClick={onRefresh}>
        <Icon name="refresh" size={14} />
        {busy ? "Refreshing pack" : "Refresh Pack"}
      </button>
    </section>
  );
}
