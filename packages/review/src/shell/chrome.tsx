import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, RefObject } from "preact";
import type { KernelError } from "@wolfsdk/protocol";
import { Icon } from "./icons.tsx";
import { displayKeys, type Collision, type ListedShortcut } from "./shortcuts.ts";

/** Close a popup on Escape or on a pointer press outside `ref` (shadow-root safe: `composedPath`). */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  ignore?: RefObject<HTMLElement>,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const root = el.getRootNode() as Document | ShadowRoot;
    const onPointer = (event: Event) => {
      const path = event.composedPath();
      if (path.includes(el) || (ignore?.current && path.includes(ignore.current))) return;
      close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    root.addEventListener("pointerdown", onPointer, true);
    el.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("pointerdown", onPointer, true);
      el.removeEventListener("keydown", onKey);
    };
  }, [open, ref, ignore]);
}

export function ErrorToast({ error, onDismiss }: { error: KernelError; onDismiss: () => void }) {
  const { code, message, argument, ...rest } = error;
  const extra = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null;
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [error]);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(error, null, 2))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div class="we-shell-toast" role="alert" data-testid="shell-error">
      <span class="we-shell-toast-icon">
        <Icon name="alert" size={18} />
      </span>
      <div class="we-shell-toast-body">
        <div class="we-shell-toast-head">
          <strong class="we-shell-error-code" data-testid="shell-error-code">
            {code}
          </strong>
        </div>
        <div class="we-shell-toast-message" data-testid="shell-error-message">
          {message}
        </div>
        {argument !== undefined && (
          <code class="we-shell-error-argument" data-testid="shell-error-argument">
            {argument}
          </code>
        )}
        {extra && (
          <details class="we-shell-error-extra">
            <summary>More details</summary>
            <pre>{extra}</pre>
          </details>
        )}
        <div class="we-shell-toast-actions">
          <button
            class="we-btn we-btn--small we-btn--outline"
            title="Copy the code, message and argument as JSON"
            aria-label="Copy error details"
            data-testid="shell-error-copy"
            onClick={copy}
          >
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      </div>
      <button
        class="we-btn we-btn--icon we-btn--small we-shell-toast-close"
        title="Dismiss (Escape)"
        aria-label="Dismiss error"
        data-testid="shell-error-dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/** A button with a popup panel anchored to it; the panel stays in the DOM (hidden) so its test ids exist. */
export function PopoverButton(props: {
  label: string;
  title: string;
  testid: string;
  panelTestid: string;
  icon?: ComponentChildren;
  text?: ComponentChildren;
  placement?: "up" | "down";
  onOpenChange?: (open: boolean) => void;
  /** The panel, or a function given `close` (for an item that hands over to a dialog). */
  children: ComponentChildren | ((close: () => void) => ComponentChildren);
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const toggle = (next: boolean) => {
    setOpen(next);
    props.onOpenChange?.(next);
  };
  useDismiss(open, wrap, () => toggle(false));
  return (
    <span class="we-shell-popover-anchor" ref={wrap}>
      <button
        class="we-btn we-btn--small"
        title={props.title}
        aria-label={props.label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid={props.testid}
        onClick={() => toggle(!open)}
      >
        {props.icon}
        {props.text}
      </button>
      <div
        class={`we-shell-popover we-menu we-shell-popover-${props.placement ?? "up"}`}
        role="dialog"
        aria-label={props.label}
        hidden={!open}
        data-testid={props.panelTestid}
      >
        {typeof props.children === "function" ? props.children(() => toggle(false)) : props.children}
      </div>
    </span>
  );
}

/**
 * The shortcut table, generated from the registry (`shortcuts.ts`): the shell's keys and
 * those the active plugins declare, grouped, with a notice for keys bound twice.
 */
export function ShortcutsSheet({
  list,
  collisions,
  onClose,
}: {
  list: ListedShortcut[];
  collisions: Collision[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = (panel.current?.getRootNode() as Document | ShadowRoot | undefined)
      ?.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useDismiss(true, panel, onClose);
  useFocusTrap(panel);
  // One row per group and label; alternative keys of the same command share it.
  const groups = new Map<string, Map<string, { label: string; keys: string[]; when?: string }>>();
  for (const s of list) {
    const rows = groups.get(s.group) ?? new Map<string, { label: string; keys: string[]; when?: string }>();
    groups.set(s.group, rows);
    const id = `${s.label}|${s.when ?? ""}`;
    const row = rows.get(id) ?? { label: s.label, keys: [], when: s.when };
    rows.set(id, row);
    row.keys.push(displayKeys(s.keys));
  }
  return (
    <div class="we-shell-scrim">
      <div
        class="we-shell-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="we-shell-shortcuts-title"
        data-testid="shell-shortcuts"
        ref={panel}
      >
        <div class="we-shell-sheet-head">
          <h2 id="we-shell-shortcuts-title">Keyboard shortcuts</h2>
          <button
            ref={closeBtn}
            class="we-btn we-btn--icon we-btn--small"
            title="Close (Escape)"
            aria-label="Close keyboard shortcuts"
            data-testid="shell-shortcuts-close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {collisions.length > 0 && (
          <div
            class="we-notice we-notice--warning we-shell-sheet-note"
            role="note"
            data-testid="shell-shortcuts-collisions"
          >
            {collisions.map((c) => (
              <div key={c.keys + (c.when ?? "")}>
                <kbd>{displayKeys(c.keys)}</kbd>
                {c.when ? ` (${c.when})` : ""} is bound twice:{" "}
                {c.entries.map((e) => `${e.label} (${e.source})`).join(" and ")}
              </div>
            ))}
          </div>
        )}
        <div class="we-shell-shortcut-groups">
          {[...groups].map(([group, rows]) => (
            <section key={group} class="we-shell-shortcut-group" data-testid={`shell-shortcuts-group-${group}`}>
              <h3>{group}</h3>
              <dl class="we-shell-shortcut-list">
                {[...rows].map(([id, row]) => (
                  <div key={id} class="we-shell-shortcut">
                    <dt>
                      {row.keys.map((k, i) => (
                        <>
                          {i > 0 && <span class="we-shell-muted"> or </span>}
                          <kbd>{k}</kbd>
                        </>
                      ))}
                    </dt>
                    <dd>
                      {row.label}
                      {row.when && <span class="we-shell-muted">, {row.when}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p class="we-shell-muted we-shell-sheet-note">
          Shortcuts never fire while you type in a field or edit text on the page.
        </p>
      </div>
    </div>
  );
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep Tab and Shift+Tab inside a modal dialog. */
export function useFocusTrap(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => !n.hidden && n.offsetParent !== null,
      );
      if (!items.length) return;
      const root = el.getRootNode() as Document | ShadowRoot;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && root.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && root.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [ref]);
}

const CONTROLS = "button, select, input, textarea, a[href], label, [role=button], [tabindex]";

/**
 * One line of plugin toolbars that never wraps. Plugins lay out as they
 * like; the row shows the first line and clips the rest, and "More" expands
 * the same DOM into a panel over the canvas (plugin state survives). Focus
 * or a scroll into a clipped control expands it too.
 */
export function OverflowRow({ children, testid }: { children: ComponentChildren; testid: string }) {
  const clip = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [lineHeight, setLineHeight] = useState<number | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);
  const firstBottom = useRef(Infinity);

  useLayoutEffect(() => {
    const c = content.current;
    const outer = clip.current;
    if (!c || !outer) return;
    const measure = () => {
      const top = c.getBoundingClientRect().top;
      const rects = [...c.querySelectorAll<HTMLElement>(CONTROLS)]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) {
        setOverflow(false);
        setLineHeight(null);
        return;
      }
      const minTop = Math.min(...rects.map((r) => r.top));
      const line = rects.filter((r) => r.top < minTop + r.height / 2);
      const bottom = Math.max(...line.map((r) => r.bottom));
      firstBottom.current = bottom;
      setLineHeight(Math.ceil(bottom - top));
      // A wrapped line, or a control pushed past the right edge by a row that does not wrap.
      const right = outer.getBoundingClientRect().right;
      const overflows = rects.some((r) => r.top >= bottom - 1 || r.right > right + 1);
      setOverflow(overflows);
      // Widened until everything fits on one line with room to spare (so the closed row,
      // which also holds More, fits too): nothing left to show behind More.
      if (!overflows && rects.every((r) => r.right <= right - 96)) setOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(c);
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);

  useDismiss(open, clip, () => setOpen(false), more);

  const expandFor = (target: EventTarget | null) => {
    if (open || !(target instanceof Element)) return;
    if (target.getBoundingClientRect().top >= firstBottom.current - 1 || (clip.current?.scrollTop ?? 0) > 0)
      setOpen(true);
  };

  useEffect(() => {
    if (open && clip.current) clip.current.scrollTop = 0;
  }, [open]);

  return (
    <div class={`we-shell-ptb${open ? " is-open" : ""}`} data-testid={testid}>
      <div
        ref={clip}
        class="we-shell-ptb-clip"
        id="we-shell-ptb-clip"
        style={!open && lineHeight !== null ? { height: `${lineHeight + 4}px` } : undefined}
        onFocusIn={(e) => expandFor(e.target)}
        onScroll={() => {
          if (!open && (clip.current?.scrollTop ?? 0) > 0) setOpen(true);
        }}
      >
        <div ref={content} class="we-shell-ptb-content">
          {children}
        </div>
      </div>
      {(overflow || open) && (
        <button
          ref={more}
          class="we-btn we-btn--small we-shell-ptb-more"
          title={open ? "Show one line of tools" : "Show all tools"}
          aria-label={open ? "Fewer tools" : "More tools"}
          aria-expanded={open}
          aria-controls="we-shell-ptb-clip"
          data-testid="shell-toolbar-more"
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <Icon name={open ? "chevronDown" : "more"} />
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/** Drag handle between the canvas and a side column; arrow keys resize too. */
export function Splitter(props: {
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  label: string;
  testid: string;
  onResize: (width: number) => void;
}) {
  const { edge, width, min, max, onResize } = props;
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  return (
    <div
      class={`we-shell-splitter we-shell-splitter-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${props.label}: drag or use the arrow keys`}
      data-testid={props.testid}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startW = width;
        const move = (e: PointerEvent) =>
          onResize(clamp(startW + (edge === "left" ? e.clientX - startX : startX - e.clientX)));
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const grow = edge === "left" ? 1 : -1;
        if (event.key === "ArrowLeft") onResize(clamp(width - step * grow));
        else if (event.key === "ArrowRight") onResize(clamp(width + step * grow));
        else return;
        event.preventDefault();
      }}
    />
  );
}
