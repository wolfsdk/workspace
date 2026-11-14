/**
 * DOM helpers that work the same in a document and inside a shadow root (the
 * `<wolf-review>` element). Events crossing a shadow boundary are retargeted
 * to the host element, so `event.target` and `document.activeElement` must
 * not be used to find the node the user acted on.
 */

/** The innermost node an event was dispatched to (open shadow roots included). */
export function eventOrigin(e: Event): EventTarget | null {
  return e.composedPath()[0] ?? e.target;
}

/** True when the event passed through `el` (i.e. happened on or inside it). */
export function eventInside(e: Event, ...els: (Element | null | undefined)[]): boolean {
  const path = e.composedPath();
  return els.some((el) => !!el && path.includes(el));
}

/** The event comes from a text entry (input, textarea, select, contenteditable). */
export function typing(e: Event): boolean {
  const origin = eventOrigin(e);
  if (!(origin instanceof HTMLElement)) return false;
  return origin.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(origin.tagName);
}

/** The focused element as seen from `node`'s tree, descending into open
 * shadow roots (`document.activeElement` stops at the shadow host). */
export function activeElement(node: Node): Element | null {
  let active = (node.getRootNode() as Document | ShadowRoot).activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * Place a `position: fixed` element at viewport point (x, y), clamped to the
 * visible area. A containing block other than the viewport (an ancestor with
 * `transform` or `contain`, e.g. the embed's `:host { contain: content }`)
 * shifts and clips fixed elements, so measure the offset and clamp to it.
 */
export function placeFixed(el: HTMLElement, x: number, y: number, margin = 4): void {
  el.style.left = "0px";
  el.style.top = "0px";
  const origin = el.getBoundingClientRect();
  const root = el.getRootNode();
  const frame = root instanceof ShadowRoot ? root.host.getBoundingClientRect() : null;
  const minX = Math.max(0, frame?.left ?? 0) + margin;
  const minY = Math.max(0, frame?.top ?? 0) + margin;
  const maxX = Math.min(window.innerWidth, frame?.right ?? Infinity) - el.offsetWidth - margin;
  const maxY = Math.min(window.innerHeight, frame?.bottom ?? Infinity) - el.offsetHeight - margin;
  const left = Math.max(minX, Math.min(x, maxX));
  const top = Math.max(minY, Math.min(y, maxY));
  el.style.left = `${left - origin.left}px`;
  el.style.top = `${top - origin.top}px`;
}
