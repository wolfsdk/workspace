/** @jsxImportSource preact */
// Behind a hosting front the page starts with no token: it asks the front for the session once, then asks the server
// who the caller is with no `Authorization` header and opens the room socket with no `token` parameter. These tests
// walk the start sequence `App` runs (`takeToken`, `startCredential`, `apiFor(...).me()`, `socketUrlFor`) and the
// sign-out and 401 paths against a fake page, in both modes.
import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { ApiError } from "../src/lib/api.ts";
import {
  apiFor,
  HOSTED_SESSION_PATH,
  type PageIo,
  probeHostedSession,
  signOutHosted,
  socketUrlFor,
  startCredential,
  takeToken,
  TOKEN_KEY,
} from "../src/lib/session.ts";
import { SessionControls } from "../src/ui/common.tsx";
import { HostedGate, SignIn } from "../src/ui/sign-in.tsx";
import { ALICE, fakePage, HOSTED, jsonResponse, type SeenRequest } from "./fixtures.ts";

const ORIGIN = "https://acme.cloud.example.com";
const noop = (): void => undefined;

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A server behind a front holding Alice's session: `/-/session` answers her account, `/api/me` her actor, and
 * `/-/sign-out` ends the session. With `token`, the server also knows that actor token. */
function hostedServer(request: SeenRequest, token?: string): Response {
  if (request.url === HOSTED_SESSION_PATH) return jsonResponse(200, HOSTED);
  if (request.url === HOSTED.signOut && request.method === "POST") return new Response(null, { status: 204 });
  if (request.url === `${ORIGIN}/api/me`) {
    const known = request.authorization === null || (token !== undefined && request.authorization === `Bearer ${token}`);
    return known ? jsonResponse(200, { actor: ALICE }) : jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "unknown token" } });
  }
  return jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such path" } });
}

/** What `App` does from the page's address and tab storage to a signed-in page, or to the token form (null). */
async function start(search: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, io: PageIo) {
  const taken = takeToken(search, storage);
  const credential = await startCredential(taken.token, () => probeHostedSession(io.fetch));
  if (credential === null) return null;
  const { actor } = await apiFor(credential, ORIGIN, io).me();
  return { credential, actor, socket: socketUrlFor(credential, ORIGIN) };
}

describe("a page behind a hosting front", () => {
  test("starts without a token: one GET /-/session, then /api/me with no Authorization, then a socket with no token", async () => {
    const page = fakePage((request) => hostedServer(request));
    const storage = memory();
    const signed = await start("?room=q3-close", storage, page.io);
    expect(page.requests).toEqual([
      { method: "GET", url: "/-/session", authorization: null },
      { method: "GET", url: `${ORIGIN}/api/me`, authorization: null },
    ]);
    expect(signed?.actor).toEqual(ALICE);
    expect(signed?.credential).toEqual({ kind: "hosted", session: HOSTED });
    expect(signed?.socket).toBe("wss://acme.cloud.example.com/ws");
    expect(new URL(signed!.socket).searchParams.has("token")).toBe(false);
    expect(storage.values.size).toBe(0);
    expect(page.visited).toEqual([]);
  });

  test("shows no token form and no Switch token control, and names the account", () => {
    const html = render(<SessionControls actor={ALICE} account={HOSTED.account} onSignOut={noop} />);
    expect(html).not.toContain("Switch token");
    expect(html).not.toContain('type="password"');
    expect(html).toContain(">Sign out<");
    expect(html).toContain("alice@acme.example");
    expect(html).toContain('title="Signed in as Alice Chen"');
  });

  test("links to the front's agent-token page and plan page when the front names them, and to neither otherwise", () => {
    const named = render(<SessionControls actor={ALICE} account={HOSTED.account} accountPage="/-/account" plansPage="/-/upgrade" onSignOut={noop} />);
    expect(named).toMatch(/<a [^>]*href="\/-\/account"[^>]*>Connect an agent<\/a>/);
    expect(named).toMatch(/<a [^>]*href="\/-\/upgrade"[^>]*>Plan<\/a>/);
    const unnamed = render(<SessionControls actor={ALICE} account={HOSTED.account} onSignOut={noop} />);
    expect(unnamed).not.toContain("Connect an agent");
    expect(unnamed).not.toContain("<a ");
  });

  test("a server that fails to answer /api/me gets a way to try again, never the token form", () => {
    const html = render(<HostedGate error="The server did not say who is signed in (GET /api/me: Bad Gateway)." busy={false} onRetry={noop} />);
    expect(html).toContain("GET /api/me: Bad Gateway");
    expect(html).toContain("Try again");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Access token");
  });

  test("Sign out ends the session at the front with POST /-/sign-out, then opens its sign-in page", async () => {
    const page = fakePage((request) => hostedServer(request));
    await signOutHosted(HOSTED, page.io);
    expect(page.requests).toEqual([{ method: "POST", url: "/-/sign-out", authorization: null }]);
    expect(page.visited).toEqual(["/-/sign-in"]);
  });

  test("a sign-out the front refuses or never gets keeps the page and says what to do", async () => {
    const refused = fakePage(() => new Response("busy", { status: 503 }));
    const error = await signOutHosted(HOSTED, refused.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "SIGN_OUT_FAILED" });
    expect((error as Error).message).toBe(
      "Sign out did not finish: POST /-/sign-out answered 503. Try Sign out again, or close the browser to end the session.",
    );
    expect(refused.visited).toEqual([]);

    const offline = fakePage(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await signOutHosted(HOSTED, offline.io).catch((e: unknown) => e)).toMatchObject({ status: 0, code: "SIGN_OUT_FAILED" });
    expect(offline.visited).toEqual([]);
  });

  test("a 401 from any API call (the session expired or was revoked) opens the sign-in page", async () => {
    let live = true;
    const page = fakePage((request) =>
      live || request.url === HOSTED_SESSION_PATH ? hostedServer(request) : jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "session ended" } }),
    );
    const api = apiFor({ kind: "hosted", session: HOSTED }, ORIGIN, page.io);
    await api.me();
    expect(page.visited).toEqual([]);
    live = false;
    const error = await api.rooms().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(page.visited).toEqual(["/-/sign-in"]);
    expect(page.requests.at(-1)).toEqual({ method: "GET", url: `${ORIGIN}/api/rooms`, authorization: null });
  });

  test("a refusal other than 401 stays on the page", async () => {
    const page = fakePage(() => jsonResponse(403, { error: { code: "FORBIDDEN", message: "only a user decides" } }));
    const api = apiFor({ kind: "hosted", session: HOSTED }, ORIGIN, page.io);
    expect(await api.rooms().catch((e: unknown) => e)).toMatchObject({ status: 403 });
    expect(page.visited).toEqual([]);
  });
});

describe("a page that is not behind a hosting front", () => {
  const answers: [string, (request: SeenRequest) => Response | Promise<Response>][] = [
    ["the app page as HTML with status 200", () => new Response("<!doctype html><title>Wolf Workspace</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })],
    ["a 404", () => new Response("not found", { status: 404 })],
    ["a 401 JSON body", () => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "no session" } })],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 200 JSON body of another shape", () => jsonResponse(200, { account: { email: "alice@acme.example" } })],
    ["a sign-in path on another origin", () => jsonResponse(200, { ...HOSTED, signIn: "//elsewhere.example/sign-in" })],
  ];

  for (const [name, respond] of answers) {
    test(`shows the token form for ${name}, after asking once`, async () => {
      const page = fakePage(respond);
      const storage = memory();
      expect(await start("", storage, page.io)).toBeNull();
      expect(page.requests).toEqual([{ method: "GET", url: "/-/session", authorization: null }]);
      expect(page.visited).toEqual([]);
      expect(storage.values.size).toBe(0);
    });
  }

  test("the token form is the one it has always shown", () => {
    const html = render(<SignIn error={null} busy={false} onSubmit={noop} />);
    expect(html).toContain("Sign in with your access token");
    expect(html).toContain('type="password"');
  });
});

describe("token sign-in is unchanged", () => {
  test("a token in the address wins over a hosted session and asks nothing of the front", async () => {
    const token = crypto.randomUUID();
    const page = fakePage((request) => hostedServer(request, token));
    const storage = memory();
    const signed = await start(`?token=${token}&room=q3-close`, storage, page.io);
    expect(page.requests).toEqual([{ method: "GET", url: `${ORIGIN}/api/me`, authorization: `Bearer ${token}` }]);
    expect(signed?.credential).toEqual({ kind: "token", token });
    expect(signed?.socket).toBe(`wss://acme.cloud.example.com/ws?token=${token}`);
    expect(storage.values.get(TOKEN_KEY)).toBe(token);
  });

  test("a token stored for the tab signs in with it, and a 401 does not leave the page", async () => {
    const token = crypto.randomUUID();
    const page = fakePage(() => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "unknown token" } }));
    const credential = await startCredential(takeToken("", memory({ [TOKEN_KEY]: token })).token, () => probeHostedSession(page.io.fetch));
    expect(credential).toEqual({ kind: "token", token });
    const error = await apiFor(credential!, ORIGIN, page.io).me().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(page.requests).toEqual([{ method: "GET", url: `${ORIGIN}/api/me`, authorization: `Bearer ${token}` }]);
    expect(page.visited).toEqual([]);
  });

  test("the top bar keeps Switch token and Sign out, with no account", () => {
    const html = render(<SessionControls actor={ALICE} account={null} onSwitchToken={noop} onSignOut={noop} />);
    expect(html).toContain("Switch token");
    expect(html).toContain(">Sign out<");
    expect(html).not.toContain("Signed in as");
  });
});
