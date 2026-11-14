/**
 * Original (revision 0) bytes of the document open in a host.
 *
 * `KernelClient` has no call that returns an older revision's bytes, so a
 * watched host has them taken from `host.save()` whenever it is seen at
 * revision 0 (right after `open`, or when the reviewer steps back there).
 * When the bytes are first asked for past revision 0 with nothing captured,
 * the only route is `host.goto(0)`, `host.save()`, `host.goto(back)`, queued
 * back to back once the host is idle, once per document. Either way the bytes
 * are only handed out after their SHA-256, computed here, equals the
 * `originalSha256` the kernel recorded at `open`.
 */
import type { DocId } from "@wolfsdk/protocol";
import type { EditorHost } from "../host/index.ts";

/** How the original bytes were obtained: kept from a visit to revision 0, saved
 * because the host was at revision 0 when asked, or by moving the host there. */
export type OriginalRoute = "captured" | "current" | "goto";
export type Original = { bytes: Uint8Array; sha256: string; route: OriginalRoute };

type Watch = {
  host: EditorHost;
  /** Open document the fields below belong to. */
  doc: DocId | null;
  /** Save taken at revision 0 of `doc`, not yet verified; null bytes when the save failed. */
  capture: Promise<Uint8Array | null> | null;
  /** Read shared by every caller for `doc`; holds the verified bytes once done. */
  reading: Promise<Original> | null;
  /** Host moves for original bytes, all documents. */
  moves: number;
};

const watches = new WeakMap<EditorHost, Watch>();

function ensure(host: EditorHost): Watch {
  let w = watches.get(host);
  if (w) return w;
  w = { host, doc: null, capture: null, reading: null, moves: 0 };
  watches.set(host, w);
  const watch = w;
  host.subscribe(() => observe(watch));
  return w;
}

/** Drop everything held for a document that is no longer open. */
function track(w: Watch): void {
  const doc = w.host.getSnapshot().state?.doc ?? null;
  if (doc === w.doc) return;
  w.doc = doc;
  w.capture = null;
  w.reading = null;
}

function observe(w: Watch): void {
  track(w);
  const state = w.host.getSnapshot().state;
  // No capture while a read runs: the goto route's own visit to revision 0
  // would queue its save after the move back.
  if (!state || state.revision !== 0 || w.capture || w.reading) return;
  const taken = w.host.save().then(
    (bytes) => bytes,
    () => null,
  );
  w.capture = taken;
  void taken.then((bytes) => {
    if (bytes === null && w.capture === taken) w.capture = null;
  });
}

export function watchOriginal(host: EditorHost): void {
  // Re-observing is harmless: a capture starts only when none is held.
  observe(ensure(host));
}

export function originalBytes(host: EditorHost): Promise<Original> {
  const w = ensure(host);
  track(w);
  if (!w.doc) return Promise.reject(new Error("No document is open"));
  if (!w.reading) {
    const reading = read(w, w.doc);
    w.reading = reading;
    reading.catch(() => {
      if (w.reading === reading) w.reading = null;
    });
  }
  return w.reading;
}

export function originalHostMoves(host: EditorHost): number {
  return watches.get(host)?.moves ?? 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function still(w: Watch, doc: DocId): void {
  if (w.doc !== doc) throw new Error("The document changed before its original file was read");
}

async function read(w: Watch, doc: DocId): Promise<Original> {
  const host = w.host;
  const want = (await host.kernel.session(doc)).originalSha256;
  still(w, doc);
  let sha = "";
  const verify = async (bytes: Uint8Array, route: OriginalRoute): Promise<Original | null> => {
    sha = await sha256Hex(bytes);
    still(w, doc);
    return sha === want ? { bytes, sha256: sha, route } : null;
  };
  const captured = w.capture ? await w.capture : null;
  still(w, doc);
  let found: Original | null = null;
  if (captured) found = await verify(captured, "captured");
  else if (host.getSnapshot().state?.revision === 0) found = await verify(await host.save(), "current");
  if (found) return found;
  // The capture or save raced an apply; it is not used again.
  w.capture = null;
  found = await verify(await viaGoto(w, doc), "goto");
  if (found) return found;
  throw new Error(
    `the original file could not be read back (SHA-256 ${sha.slice(0, 12)} differs from ${want.slice(0, 12)} recorded at open)`,
  );
}

/** Move the host to revision 0, save, move back. */
async function viaGoto(w: Watch, doc: DocId): Promise<Uint8Array> {
  const host = w.host;
  // Nothing may run between the three calls (an apply at revision 0 would
  // drop the redo tail), so wait until the host is idle and queue them together.
  while (host.getSnapshot().busy) await idle(host);
  const state = host.getSnapshot().state;
  if (!state || state.doc !== doc) throw new Error("The document changed before its original file was read");
  const back = state.revision;
  w.moves++;
  const there = host.goto(0);
  const saved = host.save();
  const home = host.goto(back);
  try {
    await there;
    return await saved;
  } finally {
    await home;
  }
}

function idle(host: EditorHost): Promise<void> {
  if (!host.getSnapshot().busy) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const off = host.subscribe(() => {
    if (host.getSnapshot().busy) return;
    off();
    resolve();
  });
  return promise;
}
