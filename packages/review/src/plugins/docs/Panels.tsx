import type { Address, ViewNode } from "@wolfsdk/protocol";
import type { PluginProps } from "../../host/index.ts";
import { formatDateTime } from "@wolfsdk/protocol";
import { useEditor } from "../../host/index.ts";
import { useEffect, useRef, useState } from "preact/hooks";
import { deleteComment, editComment, replyToComment, reviewRevisions } from "./actions.ts";
import { paragraphOf } from "./addresses.ts";
import { type Binding, dispatch, type KeyContext } from "./shortcuts.ts";
import { useDocs, type DocsStore } from "./store.ts";

/** Comment and revision dates; the raw value when it is not a time. */
function when(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  return formatDateTime(value) || value;
}

function testKey(id: Address): string {
  return id.replace(/^[a-z]+:#?/, "");
}

/** Select the paragraph a comment or revision belongs to and bring it into view. */
function selectAnchor(store: DocsStore, para: Address | undefined): void {
  if (!para) return;
  store.host.select([para]);
  store.host.reveal({ address: para });
}

/** Clicking a card outside its own controls selects and reveals its paragraph. */
function cardClick(store: DocsStore, para: Address | undefined) {
  return (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, form, a")) return;
    selectAnchor(store, para);
  };
}

function anchorText(node: ViewNode): string {
  const anchor = typeof node.anchor === "string" ? node.anchor : "";
  const span = anchor.indexOf("/span:");
  return span >= 0 ? anchor.slice(span + 6) : "";
}

function ReplyForm({ store, comment }: { store: DocsStore; comment: Address }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const key = testKey(comment);
  if (!open) {
    return (
      <button
        type="button"
        class="we-btn we-btn--small"
        data-testid={`docs-comment-reply-${key}`}
        title="Reply"
        aria-label="Reply"
        onClick={() => setOpen(true)}
      >
        Reply
      </button>
    );
  }
  return (
    <form
      class="we-docs-reply"
      onSubmit={async (e) => {
        e.preventDefault();
        await replyToComment(store, comment, text);
        if (store.ui.notice?.kind !== "error") {
          setText("");
          setOpen(false);
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        dispatch(REPLY_KEYS, { store, event: e, close: () => setOpen(false) });
      }}
    >
      <input
        class="we-input we-docs-wide"
        data-testid={`docs-comment-reply-text-${key}`}
        aria-label="Reply text"
        title="Reply text"
        placeholder="Reply"
        value={text}
        ref={(el) => el?.focus()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <button
        type="submit"
        class="we-btn we-btn--small we-btn--primary"
        data-testid={`docs-comment-reply-ok-${key}`}
        title="Send reply"
        aria-label="Send reply"
      >
        Send
      </button>
      <button
        type="button"
        class="we-btn we-btn--small"
        data-testid={`docs-comment-reply-cancel-${key}`}
        title="Cancel"
        aria-label="Cancel"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </form>
  );
}

/** The comment forms' keys (they dispatch them; also the plugin's shortcut list). */
export const REPLY_KEYS: readonly Binding<KeyContext & { close: () => void }>[] = [
  // Enter submits the form (the browser's own handling).
  { keys: "Enter", label: "Send the reply", group: "Comments", when: "in a comment reply field" },
  {
    keys: "Escape",
    label: "Cancel the reply",
    group: "Comments",
    when: "in a comment reply field",
    run: ({ close }) => close(),
  },
];

export const COMMENT_EDIT_KEYS: readonly Binding<KeyContext & { save: () => Promise<void>; close: () => void }>[] = [
  {
    keys: "Mod+Enter",
    label: "Save the comment text",
    group: "Comments",
    when: "while editing a comment",
    run: ({ save }) => void save(),
  },
  {
    keys: "Escape",
    label: "Cancel the comment edit",
    group: "Comments",
    when: "while editing a comment",
    run: ({ close }) => close(),
  },
];

/** Rewrites a comment's text in place (`set` on `comment:#n`). Escape cancels; Cmd/Ctrl+Enter saves. */
function EditForm({
  store,
  comment,
  text,
  close,
}: {
  store: DocsStore;
  comment: Address;
  text: string;
  close: () => void;
}) {
  const [value, setValue] = useState(text);
  const key = testKey(comment);
  const save = async () => {
    const done = await editComment(store, comment, value);
    if (done) close();
  };
  return (
    <form
      class="we-docs-reply we-docs-editform"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        dispatch(COMMENT_EDIT_KEYS, { store, event: e, save, close });
      }}
    >
      <textarea
        class="we-input we-docs-wide we-docs-edittext"
        data-testid={`docs-comment-edit-text-${key}`}
        aria-label="Comment text"
        title="Comment text (one paragraph per line)"
        rows={3}
        value={value}
        ref={(el) => {
          if (el && el.ownerDocument.activeElement !== el && !el.dataset.focused) {
            el.dataset.focused = "1";
            el.focus();
          }
        }}
        onInput={(e) => setValue(e.currentTarget.value)}
      />
      <button
        type="submit"
        class="we-btn we-btn--small we-btn--primary"
        data-testid={`docs-comment-edit-ok-${key}`}
        title="Save comment text"
        aria-label="Save comment text"
        disabled={value.trim() === "" || value === text}
      >
        Save
      </button>
      <button
        type="button"
        class="we-btn we-btn--small"
        data-testid={`docs-comment-edit-cancel-${key}`}
        title="Cancel"
        aria-label="Cancel editing"
        onClick={close}
      >
        Cancel
      </button>
    </form>
  );
}

export function CommentsPanel({ host }: PluginProps) {
  const snapshot = useEditor(host);
  const [store, ui] = useDocs(host);
  const [editing, setEditing] = useState<Address | null>(null);
  const editRefused = ui.disabled["comment-edit"];
  const state = snapshot.state;
  if (!state || state.format !== "docx") return null;
  const comments = state.nodes.filter((n) => n.kind === "comment");
  const replies = state.nodes.filter((n) => n.kind === "reply");
  const selected = new Set(snapshot.selection);
  if (comments.length === 0) {
    return (
      <div class="we-docs-panel" data-testid="docs-comments">
        <p class="we-docs-empty">No comments. Select a paragraph and use Comment in the toolbar.</p>
      </div>
    );
  }
  return (
    <div class="we-docs-panel" data-testid="docs-comments">
      {comments.map((c) => {
        const para =
          typeof c.parent === "string" ? c.parent : typeof c.anchor === "string" ? paragraphOf(c.anchor) : undefined;
        const key = testKey(c.id);
        const quote = anchorText(c);
        return (
          <article
            key={c.id}
            class={`we-docs-card${para && selected.has(para) ? " we-docs-card-active" : ""}`}
            data-testid={`docs-comment-${key}`}
            data-address={c.id}
            onClick={cardClick(store, para)}
          >
            <button
              type="button"
              class="we-docs-anchor"
              data-testid={`docs-comment-anchor-${key}`}
              title="Select the commented paragraph"
              aria-label="Select the commented paragraph"
              onClick={() => selectAnchor(store, para)}
            >
              {quote ? `"${quote}"` : (para ? (host.node(para)?.text ?? "").slice(0, 80) : "") || "Paragraph"}
            </button>
            <header class="we-docs-meta">
              <strong>{String(c.author ?? "")}</strong> <span>{when(c.date)}</span>
            </header>
            {editing === c.id ? (
              <EditForm store={store} comment={c.id} text={String(c.text ?? "")} close={() => setEditing(null)} />
            ) : (
              <p class="we-docs-body">{c.text}</p>
            )}
            {replies
              .filter((r) => r.parent === c.id)
              .map((r) => (
                <div
                  key={r.id}
                  class="we-docs-replyitem"
                  data-testid={`docs-reply-${testKey(r.id)}`}
                  data-address={r.id}
                >
                  <header class="we-docs-meta">
                    <strong>{String(r.author ?? "")}</strong> <span>{when(r.date)}</span>
                    <button
                      type="button"
                      class="we-btn we-btn--small we-btn--danger-quiet"
                      data-testid={`docs-reply-delete-${testKey(r.id)}`}
                      title="Delete reply"
                      aria-label="Delete reply"
                      onClick={() => void deleteComment(store, r.id)}
                    >
                      Delete
                    </button>
                  </header>
                  <p class="we-docs-body">{r.text}</p>
                </div>
              ))}
            <footer class="we-docs-actions">
              <ReplyForm store={store} comment={c.id} />
              {editing !== c.id && (
                <button
                  type="button"
                  class="we-btn we-btn--small"
                  data-testid={`docs-comment-edit-${key}`}
                  title={
                    editRefused
                      ? `Edit comment: refused by the engine (${editRefused.code}) ${editRefused.message}`
                      : "Edit comment text"
                  }
                  aria-label="Edit comment text"
                  disabled={!!editRefused}
                  onClick={() => setEditing(c.id)}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                class="we-btn we-btn--small we-btn--danger-quiet"
                data-testid={`docs-comment-delete-${key}`}
                title="Delete comment and its replies"
                aria-label="Delete comment and its replies"
                onClick={() => void deleteComment(store, c.id)}
              >
                Delete
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}

export function TrackedChangesPanel({ host }: PluginProps) {
  const snapshot = useEditor(host);
  const [store, ui] = useDocs(host);
  const list = useRef<HTMLDivElement>(null);
  const fresh = ui.freshRevisions;
  useEffect(() => {
    // Bring the card of the change just recorded into view (receipt `ops[].revisions`).
    const first = fresh[0];
    if (!first || !list.current) return;
    for (const card of list.current.querySelectorAll<HTMLElement>("[data-address]")) {
      if (card.dataset.address === first) card.scrollIntoView({ block: "nearest" });
    }
  }, [fresh]);
  const state = snapshot.state;
  if (!state || state.format !== "docx") return null;
  const revisions = state.nodes.filter((n) => n.kind === "revision");
  const ids = revisions.map((r) => r.id);
  return (
    <div class="we-docs-panel" data-testid="docs-changes" ref={list}>
      <div class="we-docs-actions">
        <button
          type="button"
          class="we-btn we-btn--small"
          data-testid="docs-accept-all"
          title="Accept all tracked changes"
          aria-label="Accept all tracked changes"
          disabled={ids.length === 0}
          onClick={() => void reviewRevisions(store, ids, "accept")}
        >
          Accept all
        </button>
        <button
          type="button"
          class="we-btn we-btn--small"
          data-testid="docs-reject-all"
          title="Reject all tracked changes"
          aria-label="Reject all tracked changes"
          disabled={ids.length === 0}
          onClick={() => void reviewRevisions(store, ids, "reject")}
        >
          Reject all
        </button>
      </div>
      {revisions.length === 0 && (
        <p class="we-docs-empty">No tracked changes. Turn on Track changes in the toolbar to record edits.</p>
      )}
      {revisions.map((r) => {
        const key = testKey(r.id);
        const para = typeof r.parent === "string" ? r.parent : undefined;
        const kind = r.revision_kind === "del" ? "Deleted" : "Inserted";
        return (
          <article
            key={r.id}
            class={`we-docs-card we-docs-rev-${r.revision_kind === "del" ? "del" : "ins"}${fresh.includes(r.id) ? " we-docs-card-active" : ""}`}
            data-testid={`docs-change-${key}`}
            data-address={r.id}
            aria-current={fresh.includes(r.id) ? "true" : undefined}
            onClick={cardClick(store, para)}
          >
            <header class="we-docs-meta">
              <strong>{kind}</strong> <span>{String(r.author ?? "")}</span> <span>{when(r.date)}</span>
            </header>
            <button
              type="button"
              class="we-docs-anchor"
              data-testid={`docs-change-anchor-${key}`}
              title="Select the changed paragraph"
              aria-label="Select the changed paragraph"
              onClick={() => selectAnchor(store, para)}
            >
              {r.text ? <span class="we-docs-revtext">{r.text}</span> : <em>paragraph mark</em>}
            </button>
            <footer class="we-docs-actions">
              <button
                type="button"
                class="we-btn we-btn--small we-btn--success"
                data-testid={`docs-change-accept-${key}`}
                title="Accept this tracked change"
                aria-label="Accept this tracked change"
                onClick={() => void reviewRevisions(store, [r.id], "accept")}
              >
                Accept
              </button>
              <button
                type="button"
                class="we-btn we-btn--small we-btn--danger"
                data-testid={`docs-change-reject-${key}`}
                title="Reject this tracked change"
                aria-label="Reject this tracked change"
                onClick={() => void reviewRevisions(store, [r.id], "reject")}
              >
                Reject
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
