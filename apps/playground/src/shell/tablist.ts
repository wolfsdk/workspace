/**
 * Arrow-key roving focus for a `role="tablist"` of buttons. Arrows, Home and
 * End move focus; Enter or Space activates (manual activation, so moving
 * focus never opens a scenario by itself).
 */
export function onTablistKeyDown(event: KeyboardEvent): void {
  const list = event.currentTarget as HTMLElement;
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  if (tabs.length === 0) return;
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (at + 1) % tabs.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = (at - 1 + tabs.length) % tabs.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  tabs[next]!.focus();
}

/** Roving tabindex: the selected tab, or the first when none is selected. */
export function tabIndexFor(index: number, selected: number): 0 | -1 {
  return index === (selected < 0 ? 0 : selected) ? 0 : -1;
}
