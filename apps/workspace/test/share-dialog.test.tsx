/** @jsxImportSource preact */
// The Share dialog of a member, against a fake server that keeps one link: the dialog's state machine drives the
// requests, and each state is rendered as HTML. Handlers are reached through the vnodes of the render, as a click
// would reach them. Last, what a guest of a shared document is not offered, Share among it.
import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { type PublicShare, type Share, type ShareGuest, WorkspaceApi } from "../src/lib/api.ts";
import { canShare, ShareDialogModel } from "../src/lib/share.ts";
import { documentSummaries } from "../src/lib/room-state.ts";
import { LeftRail } from "../src/ui/left-rail.tsx";
import { RightRail } from "../src/ui/right-rail.tsx";
import { ShareDialogView } from "../src/ui/share-dialog.tsx";
import { ALICE, fakePage, head, jsonResponse, proposal, publicShare, room, SCOUT, SHARE_TOKEN, shareLink, type SeenRequest } from "./fixtures.ts";

const ORIGIN = "https://acme.cloud.example.com";
const SHARE_ROUTE = `${ORIGIN}/api/rooms/q3-close/docs/memo.docx/share`;
const GUESTS_QUERY = "room=q3-close&doc=memo.docx";
const GONE = { error: { code: "SHARE_NOT_FOUND", message: "This link is not shared." } };

const BEA: ShareGuest = { id: "acct_bea", email: "bea@example.org", name: "Bea Ortiz", added_at: "2026-11-18T19:20:00Z" };
const CAL: ShareGuest = { id: "acct_cal", email: "cal@example.org", name: "", added_at: "2026-11-18T19:30:00Z" };

type ServerOptions = { live?: Share | null; meta?: PublicShare; guests?: ShareGuest[] | "absent" };

/** A server holding at most one link of memo.docx, and behind it a hosting front that lists the document's guests
 * (or has no guests route at all, `"absent"`). */
function server({ live = null, meta = publicShare(), guests = "absent" }: ServerOptions = {}) {
  let link = live;
  let listed = guests;
  const page = fakePage((request: SeenRequest) => {
    if (request.url === SHARE_ROUTE && request.method === "GET") return jsonResponse(200, { share: link });
    if (request.url === SHARE_ROUTE && request.method === "PUT") return jsonResponse(200, { share: (link ??= shareLink()) });
    if (request.url === SHARE_ROUTE && request.method === "DELETE") {
      link = null;
      return new Response(null, { status: 204 });
    }
    if (request.url === `${ORIGIN}/api/share/${SHARE_TOKEN}`) return link === null ? jsonResponse(404, GONE) : jsonResponse(200, { share: meta });
    if (listed !== "absent" && request.url === `${ORIGIN}/-/share/guests?${GUESTS_QUERY}`) return jsonResponse(200, { guests: listed, limit: 3 });
    const removal = /^.*\/-\/share\/guests\/([^?]+)\?(.*)$/.exec(request.url);
    if (listed !== "absent" && removal && request.method === "DELETE" && removal[2] === GUESTS_QUERY) {
      listed = listed.filter((g) => g.id !== decodeURIComponent(removal[1]!));
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such path" } });
  });
  return { ...page, api: new WorkspaceApi(ORIGIN, null, page.io.fetch) };
}

/** Render `node`, keeping every vnode created on the way so a test can reach a handler as a click would. */
function rendered(node: VNode): { html: string; vnodes: VNode[] } {
  const vnodes: VNode[] = [];
  const previous = options.vnode;
  options.vnode = (vnode) => {
    vnodes.push(vnode);
    previous?.(vnode);
  };
  try {
    return { html: render(node), vnodes };
  } finally {
    options.vnode = previous;
  }
}

/** The text a vnode's children spell, ignoring nested elements. */
const label = (props: Record<string, unknown>): string => [props.children].flat().filter((c) => typeof c === "string").join("");

/** The text of rendered HTML a reader sees: no tags, so no attributes. */
const visible = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** The dialog of `model` as it renders now, and a way to click a button by its label and wait for what it started. */
function dialog(model: ShareDialogModel) {
  let pending: Promise<void> | void = undefined;
  const node = (
    <ShareDialogView
      state={model.state}
      docName="memo.docx"
      origin={ORIGIN}
      copied={null}
      copyError={null}
      onCreate={() => (pending = model.create())}
      onCopy={() => undefined}
      onAskStop={() => model.askStop()}
      onKeepSharing={() => model.keepSharing()}
      onStop={() => (pending = model.stop())}
      onRemoveGuest={(id) => (pending = model.removeGuest(id))}
      onRetry={() => (pending = model.load())}
      onClose={() => undefined}
    />
  );
  const { html, vnodes } = rendered(node);
  const buttons = vnodes.filter((v) => v.type === "button").map((v) => v.props as Record<string, unknown>);
  return {
    html,
    text: visible(html),
    labels: buttons.map(label),
    async click(name: string, which = 0): Promise<void> {
      const found = buttons.filter((p) => label(p) === name || p["aria-label"] === name)[which];
      expect(found).toBeDefined();
      (found!.onClick as () => void)();
      await pending;
    },
  };
}

async function opened(fake: ReturnType<typeof server>, hosted = false): Promise<ShareDialogModel> {
  const model = new ShareDialogModel(fake.api, "q3-close", "memo.docx", { hosted, onChange: () => undefined });
  await model.load();
  return model;
}

const link = `${ORIGIN}/s/${SHARE_TOKEN}`;

describe("the Share dialog", () => {
  test("a document with no link offers one action, and choosing it creates the link and shows it", async () => {
    const fake = server();
    const model = await opened(fake);
    const before = dialog(model);
    expect(before.labels).toContain("Create link");
    expect(before.html).not.toContain(link);
    expect(before.labels).not.toContain("Stop sharing");

    await before.click("Create link");
    expect(fake.requests.filter((r) => r.url === SHARE_ROUTE).map((r) => r.method)).toEqual(["GET", "PUT"]);
    const after = dialog(model);
    expect(after.html).toContain(`value="${link}"`);
    expect(after.labels).toEqual(expect.arrayContaining(["Copy", "Copy prompt for an agent", "Stop sharing"]));
    expect(after.labels).not.toContain("Create link");
  });

  test("Stop sharing asks once, sends DELETE only after the second choice, and the dialog returns to no link", async () => {
    const fake = server({ live: shareLink() });
    const model = await opened(fake);
    const deletes = (): number => fake.requests.filter((r) => r.method === "DELETE").length;
    expect(dialog(model).html).toContain(link);

    // Without the confirmation nothing ends the link.
    await model.stop();
    await dialog(model).click("Stop sharing");
    expect(deletes()).toBe(0);
    const asking = dialog(model);
    expect(asking.text).toContain("The link stops working for everyone who has it.");
    await asking.click("Keep sharing");
    expect(deletes()).toBe(0);
    expect(dialog(model).labels).toContain("Copy");

    await dialog(model).click("Stop sharing");
    await dialog(model).click("Stop sharing");
    expect(deletes()).toBe(1);
    const after = dialog(model);
    expect(after.labels).toContain("Create link");
    expect(after.html).not.toContain(link);
    // The server agrees: the dialog opened again shows no link.
    expect(dialog(await opened(fake)).labels).toContain("Create link");
  });

  test("offers no agent prompt when the server names no instructions for agents", async () => {
    const model = await opened(server({ live: shareLink(), meta: publicShare({ connect: null }) }));
    const shown = dialog(model);
    expect(shown.labels).toContain("Copy");
    expect(shown.labels).not.toContain("Copy prompt for an agent");
  });
});

describe("the guests of a shared document", () => {
  test("behind a hosting front, lists them against the limit and removes one", async () => {
    const fake = server({ live: shareLink(), guests: [BEA, CAL] });
    const model = await opened(fake, true);
    const listed = dialog(model);
    expect(listed.text).toContain("2 of 3 guests");
    expect(listed.text).toContain("Bea Ortiz");
    expect(listed.text).toContain("cal@example.org");

    await listed.click("Remove Bea Ortiz");
    expect(fake.requests.at(-1)).toEqual({ method: "DELETE", url: `${ORIGIN}/-/share/guests/acct_bea?${GUESTS_QUERY}`, authorization: null });
    const after = dialog(model);
    expect(after.text).toContain("1 of 3 guests");
    expect(after.text).not.toContain("Bea Ortiz");
  });

  test("a front with no guests route hides the section, and a server with no front is never asked", async () => {
    const absent = await opened(server({ live: shareLink() }), true);
    const shown = dialog(absent);
    expect(shown.labels).toContain("Copy");
    expect(shown.text).not.toContain("Guests");

    const selfHosted = server({ live: shareLink(), guests: [BEA] });
    dialog(await opened(selfHosted, false));
    expect(selfHosted.requests.some((r) => r.url.includes("/-/share/guests"))).toBe(false);
  });
});

describe("a guest of a shared document", () => {
  const scope = { docs: [{ room_id: "q3-close", doc_name: "memo.docx" }] };
  const noop = (): void => undefined;

  test("only a member user gets the Share control", () => {
    expect(canShare(ALICE, null)).toBe(true);
    expect(canShare({ ...ALICE, id: "bea", name: "Bea" }, scope)).toBe(false);
    expect(canShare(SCOUT, null)).toBe(false);
  });

  test("the rooms rail offers no new room, upload, pack or download of a head", () => {
    const left = (guest: boolean): string =>
      render(
        <LeftRail
          rooms={[{ room_id: "q3-close", workspace_id: "default", seq: 10 }]}
          roomId="q3-close"
          documents={documentSummaries(room({ documents: [{ head: head("memo.docx", 1) }] }))}
          activeDoc="memo.docx"
          pack={{ dir: "pack", report: { pack_id: "q3-board", fresh: true, bindings: [] } }}
          packBusy={false}
          uploading={null}
          guest={guest}
          onSelectRoom={noop}
          onCreateRoom={async () => true}
          onSelectDoc={noop}
          onUpload={noop}
          onDownloadHead={noop}
          onRefreshPack={noop}
        />,
      );
    const refused = ['aria-label="New room"', 'aria-label="Upload documents"', 'type="file"', "q3-board", 'aria-label="Download head of memo.docx"'];
    for (const control of refused) expect(left(false)).toContain(control);
    const guest = left(true);
    for (const control of refused) expect(guest).not.toContain(control);
    expect(guest).toContain("memo.docx");
  });

  test("the review rail shows proposals with no Approve, Reject or preview download, and says edits go in as proposals", () => {
    const right = (guest: boolean): string =>
      render(
        <RightRail
          tab="proposals"
          onTab={noop}
          actor={{ ...ALICE, id: "bea", name: "Bea" }}
          activeDoc="memo.docx"
          allDocs={false}
          onAllDocs={noop}
          proposals={[proposal("p1", "memo.docx")]}
          focusedProposal={null}
          deciding={null}
          onInspect={noop}
          onDecide={noop}
          onDownloadPreview={noop}
          threads={[]}
          selection={null}
          participants={[ALICE]}
          onComment={async () => true}
          history={[]}
          activity={[]}
          guest={guest}
        />,
      );
    const refused = [">Approve<", ">Reject<", 'aria-label="Download preview of p1"'];
    for (const control of refused) expect(right(false)).toContain(control);
    const guest = right(true);
    for (const control of refused) expect(guest).not.toContain(control);
    expect(guest).toContain("Tighten the summary");
    expect(guest).toContain("Your edits go in as proposals");
  });
});
