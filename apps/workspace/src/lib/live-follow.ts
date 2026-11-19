// The beat a live view (cells, slide text) follows the room on while it is open: a read every `POLL_MS`, longer apart
// while the server does not answer and none while the page is hidden, and one at once when the browser is back online
// or the page shows again.

/** How often an open live view reads again, and how far apart the reads get while the server does not answer. */
export const POLL_MS = 5_000;
export const POLL_MAX_MS = 30_000;

/** What a live view does on each event of the beat. */
export type Follower = {
  /** Each beat while the page shows. */
  tick(): void;
  /** Reads in a row the server did not answer: the beat waits longer after each. */
  failures(): number;
  /** The browser is back online. */
  online(): void;
  /** The browser is offline, now or from the start. */
  offline(): void;
  /** The page shows again. */
  shown(): void;
};

/** Follow the room for `follower` until the returned stop is called. */
export function follow(follower: Follower): () => void {
  const hidden = (): boolean => document.visibilityState === "hidden";
  let timer: ReturnType<typeof setTimeout>;
  const beat = (): void => {
    if (!hidden()) follower.tick();
    timer = setTimeout(beat, Math.min(POLL_MAX_MS, POLL_MS * 2 ** follower.failures()));
  };
  timer = setTimeout(beat, POLL_MS);
  const online = (): void => follower.online();
  const offline = (): void => follower.offline();
  const shown = (): void => {
    if (!hidden()) follower.shown();
  };
  if (!navigator.onLine) offline();
  addEventListener("online", online);
  addEventListener("offline", offline);
  document.addEventListener("visibilitychange", shown);
  return () => {
    clearTimeout(timer);
    removeEventListener("online", online);
    removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", shown);
  };
}
