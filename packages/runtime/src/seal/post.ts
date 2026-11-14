/**
 * The only place the seal kit calls `postMessage`. Every send, to a window, a
 * worker or a worker's own scope, goes through `post`.
 *
 * Why a helper: JavaScriptCore (WebKit) implements proper tail calls in
 * strict code, and modules are strict. When `otherWindow.postMessage(...)` is
 * in tail position (`() => w.postMessage(m, o)`, `return w.postMessage(m, o)`)
 * and the function was entered from a timer, a promise job or a
 * browser-fired event, the calling frame is gone by the time the native runs,
 * and WebKit 27.2 reports the message's `event.source` as the RECEIVING
 * window. The receiver's source check then drops it (the vault never booted
 * in WebKit). Chromium reports the caller in every case.
 *
 * `post` makes the native call as a statement and returns nothing, so the
 * call is never in tail position, and `post`'s own frame is the caller the
 * native sees. Callers may tail-call `post` itself. Do not turn the body into
 * a concise arrow or `return` the call: the result would be the native's
 * value, which puts it back in tail position. Any minifier that keeps the
 * semantics keeps it out of tail position, because `post` returns
 * `undefined`, not the native's result.
 */

/** Anything with a `postMessage(message, options)` form: Window, Worker, a worker scope. */
export type PostTarget<Options> = { postMessage(message: unknown, options?: Options): void };

export function post<Options>(target: PostTarget<Options>, message: unknown, options?: Options): void {
  target.postMessage(message, options);
}
