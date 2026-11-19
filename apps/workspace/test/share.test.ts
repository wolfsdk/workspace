// A share link from the browser: the page its path opens, the prompt that connects a visitor's own agent, and what
// the public page loads, which is the two public routes of the link and nothing that needs a credential.
import { describe, expect, test } from "bun:test";
import { agentPrompt, loadSharedPage, publicApiFor, shareTokenOf } from "../src/lib/share.ts";
import { displayListPage, fakePage, jsonResponse, publicShare, SHARE_TOKEN, snapshotBytes } from "./fixtures.ts";

const ORIGIN = "https://acme.cloud.example.com";
const GONE = { error: { code: "SHARE_NOT_FOUND", message: "This link is not shared." } };

describe("the agent prompt", () => {
  test("is the two lines of the contract, with the page's origin before the link and the instructions", () => {
    expect(agentPrompt(ORIGIN, SHARE_TOKEN, `/-/connect/instructions?share=${SHARE_TOKEN}`)).toBe(
      `Connect to this shared Wolf Workspace document and help me edit it: ${ORIGIN}/s/${SHARE_TOKEN}\n` +
        `Instructions for agents: ${ORIGIN}/-/connect/instructions?share=${SHARE_TOKEN}`,
    );
  });
});

describe("the share page route", () => {
  test("takes the token of /s/<token> and no other path", () => {
    expect(shareTokenOf(`/s/${SHARE_TOKEN}`)).toBe(SHARE_TOKEN);
    expect(shareTokenOf(`/s/${SHARE_TOKEN}/`)).toBe(SHARE_TOKEN);
    for (const path of ["/", "/s/", "/s", `/s/${SHARE_TOKEN}/edit`, `/api/share/${SHARE_TOKEN}`, `/x/s/${SHARE_TOKEN}`, "/s/a.b"]) {
      expect(shareTokenOf(path)).toBeNull();
    }
  });
});

describe("loading a share page", () => {
  test("asks only the two public routes of the link, with no credential, and gets the document and its pages", async () => {
    const page = fakePage((request) =>
      request.url.endsWith("/snapshot")
        ? new Response(snapshotBytes(displayListPage(1, "Hi"), displayListPage(2, "Yo")))
        : jsonResponse(200, { share: publicShare() }),
    );
    const state = await loadSharedPage(publicApiFor(ORIGIN, page.io.fetch), SHARE_TOKEN);
    expect(page.requests).toEqual([
      { method: "GET", url: `${ORIGIN}/api/share/${SHARE_TOKEN}`, authorization: null },
      { method: "GET", url: `${ORIGIN}/api/share/${SHARE_TOKEN}/snapshot`, authorization: null },
    ]);
    expect(state.kind).toBe("shared");
    if (state.kind !== "shared") return;
    expect(state.share).toEqual(publicShare());
    expect(state.pages?.map((p) => p.page)).toEqual([1, 2]);
  });

  test("an unknown or ended link is no longer shared, whichever of the two routes says so", async () => {
    const gone = fakePage(() => jsonResponse(404, GONE));
    expect(await loadSharedPage(publicApiFor(ORIGIN, gone.io.fetch), SHARE_TOKEN)).toEqual({ kind: "ended" });
    // Ended between the two requests: the snapshot says so after the metadata answered.
    const between = fakePage((request) => (request.url.endsWith("/snapshot") ? jsonResponse(404, GONE) : jsonResponse(200, { share: publicShare() })));
    expect(await loadSharedPage(publicApiFor(ORIGIN, between.io.fetch), SHARE_TOKEN)).toEqual({ kind: "ended" });
  });

  test("a server that fails is a failure to retry, never an ended link", async () => {
    const down = fakePage(() => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "no session" } }));
    expect(await loadSharedPage(publicApiFor(ORIGIN, down.io.fetch), SHARE_TOKEN)).toMatchObject({ kind: "failed" });
    // Pages that did not paint keep the document on show, with the reason.
    const noPages = fakePage((request) => (request.url.endsWith("/snapshot") ? new Response("busy", { status: 503 }) : jsonResponse(200, { share: publicShare() })));
    expect(await loadSharedPage(publicApiFor(ORIGIN, noPages.io.fetch), SHARE_TOKEN)).toMatchObject({ kind: "shared", pages: null, problem: expect.any(String) });
  });
});
