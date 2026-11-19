import { describe, expect, test } from "bun:test";
import { ApiError, WorkspaceApi } from "../src/lib/api.ts";
import { displayListPage, publicShare, SHARE_TOKEN, shareLink, snapshotBytes } from "./fixtures.ts";

type Call = { url: string; init: RequestInit | undefined };

function fake(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const api = new WorkspaceApi("http://127.0.0.1:8787/", "secret", async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  return { api, calls };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("WorkspaceApi", () => {
  test("sends the bearer token on every call", async () => {
    const { api, calls } = fake(() => json(200, { rooms: [{ room_id: "q3", workspace_id: "default", seq: 4 }] }));
    expect(await api.rooms()).toEqual([{ room_id: "q3", workspace_id: "default", seq: 4 }]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/api/rooms");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  test("behind a hosting front sends no Authorization header at all, and keeps the call's own headers", async () => {
    const calls: Call[] = [];
    const api = new WorkspaceApi("https://acme.cloud.example.com", null, async (url, init) => {
      calls.push({ url, init });
      return json(201, { room_id: "q4" });
    });
    await api.createRoom("q4");
    await api.me();
    for (const call of calls) expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe("application/json");
  });

  test("tells onUnauthorized of a 401 before throwing it, and of nothing else", async () => {
    const seen: ApiError[] = [];
    const respond = (status: number) => async () => json(status, { error: { code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", message: "no" } });
    const expired = new WorkspaceApi("https://acme.cloud.example.com", null, respond(401), { onUnauthorized: (e) => seen.push(e) });
    const error = await expired.rooms().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(seen).toEqual([error as ApiError]);
    const forbidden = new WorkspaceApi("https://acme.cloud.example.com", null, respond(403), { onUnauthorized: (e) => seen.push(e) });
    expect(await forbidden.rooms().catch((e: unknown) => e)).toMatchObject({ status: 403 });
    expect(seen).toHaveLength(1);
  });

  test("turns an error body into an ApiError with its code", async () => {
    const { api } = fake(() => json(403, { error: { code: "FORBIDDEN", message: "only a user decides" } }));
    const error = await api.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN", message: "only a user decides" });
  });

  test("names the HTTP status when the body is not JSON", async () => {
    const { api } = fake(() => new Response("nope", { status: 502, statusText: "Bad Gateway" }));
    expect(await api.me().catch((e: unknown) => e)).toMatchObject({ code: "HTTP_502", message: "Bad Gateway" });
  });

  test("reads head bytes with their receipts, escaping names", async () => {
    const { api, calls } = fake(
      () => new Response(new Uint8Array([7, 8]), { headers: { "x-wolf-sha256": "abc", "x-wolf-revision": "3" } }),
    );
    expect(await api.head("q3", "Board memo.docx")).toEqual({ bytes: new Uint8Array([7, 8]), sha256: "abc", revision: 3 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/api/rooms/q3/docs/Board%20memo.docx/head");
    const preview = await api.preview("q3", "p1");
    expect(preview.revision).toBe(3);
    expect(calls[1]!.url).toBe("http://127.0.0.1:8787/api/rooms/q3/proposals/p1/preview");
  });

  test("uploads a file as multipart form data", async () => {
    const { api, calls } = fake(() => json(201, { head: { name: "memo.docx", revision: 0 } }));
    const head = await api.upload("q3", new File([new Uint8Array([1])], "memo.docx"));
    expect(head.name).toBe("memo.docx");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = calls[0]!.init?.body as FormData;
    expect((body.get("file") as File).name).toBe("memo.docx");
  });

  test("creates a room with a JSON body", async () => {
    const { api, calls } = fake(() => json(201, { room_id: "q4" }));
    await api.createRoom("q4");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ room_id: "q4" }));
  });

  test("pack is null without a linked pack and throws on other failures", async () => {
    expect(await fake(() => json(404, { error: { code: "NO_PACK", message: "no pack" } })).api.pack()).toBeNull();
    expect(await fake(() => json(500, { error: { code: "PACK_INVALID", message: "bad" } })).api.pack().catch((e: unknown) => e)).toBeInstanceOf(ApiError);
    const { api, calls } = fake(() => json(200, { dir: "pack", report: { pack_id: "q", fresh: true, bindings: [] }, refreshed: [] }));
    expect((await api.refreshPack()).refreshed).toEqual([]);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("reads the snapshot of a head as display-list pages, escaping names", async () => {
    const { api, calls } = fake(() => new Response(snapshotBytes(displayListPage(1, "Hi"), displayListPage(2, "Yo"))));
    const pages = await api.snapshot("q3", "Board memo.docx");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/api/rooms/q3/docs/Board%20memo.docx/snapshot");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(pages.map((p) => [p.page, p.width, p.height])).toEqual([
      [1, 612, 792],
      [2, 612, 792],
    ]);
    const broken = fake(() => new Response("not json"));
    expect(await broken.api.snapshot("q3", "memo.docx").catch((e: unknown) => e)).toBeInstanceOf(Error);
    const absent = fake(() => json(404, { error: { code: "NO_DOCUMENT", message: "no such document" } }));
    expect(await absent.api.snapshot("q3", "gone.docx").catch((e: unknown) => e)).toMatchObject({ status: 404, code: "NO_DOCUMENT" });
  });

  test("me names the guest scope, and a server that predates guests answers a member", async () => {
    const scope = { docs: [{ room_id: "q3", doc_name: "memo.docx" }] };
    const actor = { kind: "user", id: "bea", name: "Bea" } as const;
    expect(await fake(() => json(200, { actor, guest: scope })).api.me()).toEqual({ actor, guest: scope });
    expect(await fake(() => json(200, { actor, guest: null })).api.me()).toEqual({ actor, guest: null });
    expect(await fake(() => json(200, { actor })).api.me()).toEqual({ actor, guest: null });
  });

  test("reads, makes and ends the share link of a document, escaping names", async () => {
    const { api, calls } = fake((call) => (call.init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, { share: shareLink({ doc_name: "Board memo.docx" }) })));
    expect((await api.shareOf("q3", "Board memo.docx"))?.token).toBe(SHARE_TOKEN);
    expect((await api.share("q3", "Board memo.docx")).doc_name).toBe("Board memo.docx");
    await api.unshare("q3", "Board memo.docx");
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url])).toEqual([
      ["GET", "http://127.0.0.1:8787/api/rooms/q3/docs/Board%20memo.docx/share"],
      ["PUT", "http://127.0.0.1:8787/api/rooms/q3/docs/Board%20memo.docx/share"],
      ["DELETE", "http://127.0.0.1:8787/api/rooms/q3/docs/Board%20memo.docx/share"],
    ]);
    expect(await fake(() => json(200, { share: null })).api.shareOf("q3", "memo.docx")).toBeNull();
    const refused = fake(() => json(403, { error: { code: "FORBIDDEN", message: "a guest does not share" } }));
    expect(await refused.api.share("q3", "memo.docx").catch((e: unknown) => e)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("reads what a link shows and its pages, and an ended link throws SHARE_NOT_FOUND", async () => {
    const { api, calls } = fake((call) => (call.url.endsWith("/snapshot") ? new Response(snapshotBytes(displayListPage(1, "Hi"))) : json(200, { share: publicShare() })));
    expect(await api.publicShare(SHARE_TOKEN)).toEqual(publicShare());
    expect((await api.publicSnapshot(SHARE_TOKEN)).map((p) => p.page)).toEqual([1]);
    expect(calls.map((c) => c.url)).toEqual([`http://127.0.0.1:8787/api/share/${SHARE_TOKEN}`, `http://127.0.0.1:8787/api/share/${SHARE_TOKEN}/snapshot`]);
    const ended = fake(() => json(404, { error: { code: "SHARE_NOT_FOUND", message: "This link is not shared." } }));
    expect(await ended.api.publicShare(SHARE_TOKEN).catch((e: unknown) => e)).toMatchObject({ status: 404, code: "SHARE_NOT_FOUND" });
    expect(await ended.api.publicSnapshot(SHARE_TOKEN).catch((e: unknown) => e)).toMatchObject({ status: 404, code: "SHARE_NOT_FOUND" });
  });

  test("guests of a document are null where nothing lists them, and other refusals throw", async () => {
    const guest = { id: "acct_bea", email: "bea@example.org", name: "Bea", added_at: "2026-11-18T19:20:00Z" };
    const { api, calls } = fake((call) => (call.init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, { guests: [guest], limit: 3 })));
    expect(await api.shareGuests("q3", "Board memo.docx")).toEqual({ guests: [guest], limit: 3 });
    await api.removeShareGuest("q3", "Board memo.docx", "acct_bea");
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url])).toEqual([
      ["GET", "http://127.0.0.1:8787/-/share/guests?room=q3&doc=Board+memo.docx"],
      ["DELETE", "http://127.0.0.1:8787/-/share/guests/acct_bea?room=q3&doc=Board+memo.docx"],
    ]);
    expect(await fake(() => json(404, { error: { code: "NOT_FOUND", message: "no route" } })).api.shareGuests("q3", "memo.docx")).toBeNull();
    const appPage = fake(() => new Response("<!doctype html><title>Wolf Workspace</title>", { headers: { "content-type": "text/html" } }));
    expect(await appPage.api.shareGuests("q3", "memo.docx")).toBeNull();
    const refused = fake(() => json(403, { error: { code: "FORBIDDEN", message: "members only" } }));
    expect(await refused.api.shareGuests("q3", "memo.docx").catch((e: unknown) => e)).toMatchObject({ status: 403 });
  });
});
