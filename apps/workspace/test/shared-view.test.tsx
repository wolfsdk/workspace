/** @jsxImportSource preact */
// The page of a share link, `/s/<token>`, as a visitor with no account sees it: loaded through the two public routes
// of the link, then rendered as HTML in each state.
import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { agentPrompt, loadSharedPage, publicApiFor, type SharedPageState } from "../src/lib/share.ts";
import { SharedPageView } from "../src/ui/shared-view.tsx";
import { displayListPage, fakePage, jsonResponse, publicShare, SHARE_TOKEN, snapshotBytes } from "./fixtures.ts";

const ORIGIN = "https://acme.cloud.example.com";
const noop = (): void => undefined;

/** A server with the link live: its metadata (`meta`) and two painted pages. */
function linkServer(meta = publicShare()) {
  return fakePage((request) =>
    request.url.endsWith("/snapshot") ? new Response(snapshotBytes(displayListPage(1, "Hi"), displayListPage(2, "Yo"))) : jsonResponse(200, { share: meta }),
  );
}

/** Load the page as a visitor does, then render what it shows. */
async function visit(page: ReturnType<typeof fakePage>): Promise<{ html: string; state: SharedPageState }> {
  const api = publicApiFor(ORIGIN, page.io.fetch);
  const state = await loadSharedPage(api, SHARE_TOKEN);
  const html = render(
    <SharedPageView state={state} token={SHARE_TOKEN} origin={ORIGIN} api={api} promptCopied={false} copyError={null} onCopyPrompt={noop} onRetry={noop} />,
  );
  return { html, state };
}

const visible = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the page of a share link", () => {
  test("shows the document, who shared it and its painted pages with no credential, asking nothing that needs one", async () => {
    const page = linkServer();
    const { html } = await visit(page);
    expect(page.requests.map((r) => r.url)).toEqual([`${ORIGIN}/api/share/${SHARE_TOKEN}`, `${ORIGIN}/api/share/${SHARE_TOKEN}/snapshot`]);
    expect(page.requests.every((r) => r.authorization === null)).toBe(true);
    expect(page.requests.some((r) => r.url.includes("/api/me") || r.url.includes("/api/rooms") || r.url.includes("/-/session"))).toBe(false);
    const text = visible(html);
    expect(text).toContain("memo.docx");
    expect(text).toContain("Shared by Alice Chen");
    expect(text).toContain("Read-only");
    expect(html.match(/<canvas /g)).toHaveLength(2);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Sign in<\/a>/);
    // No room socket and no hash of the head: the banner claims neither.
    expect(text).not.toContain("sha256");
    expect(text).not.toContain("No agents at work");
    expect(html).not.toContain("wolf-review");
    expect(html).not.toContain('type="password"');
  });

  test("offers Edit with your agent with the exact prompt when the server names instructions for agents", async () => {
    const { html } = await visit(linkServer());
    expect(html).toContain("Edit with your agent");
    const prompt = agentPrompt(ORIGIN, SHARE_TOKEN, `/-/connect/instructions?share=${SHARE_TOKEN}`);
    const shown = /<textarea[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1] ?? /<textarea[^>]*value="([^"]*)"/.exec(html)?.[1];
    expect(shown?.replace(/&#10;|&#xa;/gi, "\n")).toBe(prompt);
  });

  test("has no agent panel when the server names no instructions for agents", async () => {
    const { html } = await visit(linkServer(publicShare({ connect: null })));
    expect(html).not.toContain("Edit with your agent");
    expect(html).not.toContain("<textarea");
    expect(html.match(/<canvas /g)).toHaveLength(2);
  });

  test("an unknown or ended link says it is no longer shared and nothing about the document", async () => {
    const { html, state } = await visit(fakePage(() => jsonResponse(404, { error: { code: "SHARE_NOT_FOUND", message: "This link is not shared." } })));
    expect(state).toEqual({ kind: "ended" });
    const text = visible(html);
    expect(text).toContain("This link is no longer shared");
    expect(text).not.toContain("memo.docx");
    expect(text).not.toContain("Shared by");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("Edit with your agent");
  });
});
