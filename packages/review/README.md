# @wolfsdk/review

`<wolf-review>`: review and edit DOCX, PPTX and XLSX documents in the browser on
the Wolf engine, as one custom element. Each element renders into its own open
shadow root and runs the engine (`wolf_web.wasm`) in its own Web Worker. Every
edit, from the UI or from the page, is an engine operation, and the page hears
about it as an event. By default the element is a review workbench: it opens a
base document with a list of proposed changes, the reviewer approves or rejects
each one, and the page receives the result with a replayable log and a decision
file.

The package is plain ES modules and CSS. It does not contain the engine: the
module is tens of MB, so the element fetches it from a release channel (by
default `https://wolfsdk.com/download/wolf`), checks its SHA-256 and compiles it
once per page.

```sh
npm install @wolfsdk/review
```

## Use

```html
<script type="module">
  import "@wolfsdk/review/auto"; // or: import { defineWolfReview } from "@wolfsdk/review"; defineWolfReview();
</script>

<wolf-review engine-version="1.4.0" src="/files/report.docx" style="height: 720px"></wolf-review>
```

`defineWolfReview(tag = "wolf-review")` registers the element and returns its
class; it is idempotent and accepts another tag name.

The element starts its engine when it is in the document and stops it
(terminating the worker) when it is removed. Moving it within one task keeps the
engine and the document.

### Entry points

| Import                     | Contents                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `@wolfsdk/review`          | `WolfReviewElement`, `defineWolfReview`, `KernelRequestError`, `EngineLoadError`, the types.   |
| `@wolfsdk/review/auto`     | The same, and registers `<wolf-review>` on import.                                             |
| `@wolfsdk/review/react`    | `<WolfReview>`, a React 18/19 component around the element (registers it on import).          |
| `@wolfsdk/review/protocol` | The engine contract types and the review-session model (records, hunks, labels, part checks). |
| `@wolfsdk/review/seal`     | The sealed-page kit: response-header policy, offline loader, vault assets, egress probe.       |
| `@wolfsdk/review/wolf-review.css` | The element's styles as a file (they are also inlined in the JS), for audits and CSP review. |

React and Preact are not dependencies a page has to install: Preact is bundled,
and React is an optional peer used only by `@wolfsdk/review/react`.

### What a page loads

The code is split so that review mode pays only for review. A page that mounts
`<wolf-review mode="review">` fetches `wolf-review.js` and the two shared chunks
it imports up front (`chunks/src-*.js` and `chunks/jsxRuntime.module-*.js`):
about 101 KiB gzipped, with the stylesheet already inlined (the review shell,
the review plugin with its sheet grid, the vector page renderer and the protocol
session model are all in that set). The docs, slides and sheets plugins, with
their toolbars, editors and menus, are separate files
(`chunks/plugin-<name>-*.js`, about 29, 34 and 38 KiB gzipped): the element
fetches them with `import()` only when `mode="edit"` asks for them, renders with
the ones that have arrived and swaps the rest in. The engine worker
(`assets/worker-*.js`, about 14 KiB gzipped) loads when an engine starts.
Serve `chunks/` and `assets/` next to `wolf-review.js`.

Before the plugins were split out, the same entry was about 191 KiB gzipped
(176 KiB for `wolf-review.js` and 14.5 KiB for the shared chunk), 203 KiB with
`wolf-review.css` counted. `wolf-review.css` is the same stylesheet as a file;
a page that loads it as well as the JS pays its 9 KiB on top of the 101 KiB.
`dist/sizes.json` records each figure (`reviewEntryJsGzip`, `reviewCssGzip`,
`reviewEntryWithExternalCssGzip`, `authoringChunksGzip`) and the package check
fails when the entry grows past its budget.

## The engine

The element loads one engine module, chosen by five attributes (or the `engine`
property, which takes an `EngineSource` whose `format` may also be `auto`, and
wins over them as a whole):

| Attribute        | Property        | Meaning                                                                                                     |
| ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `engine-src`     | `engineSrc`     | Exact module URL, resolved against the document base URL. Skips the channel.                                |
| `engine-channel` | `engineChannel` | Root holding `latest.txt` and `v<VERSION>/` (default `https://wolfsdk.com/download/wolf`).                  |
| `engine-version` | `engineVersion` | Version on the channel (default: the trimmed body of `<channel>/latest.txt`). Pin it in production.        |
| `engine-sha256`  | `engineSha256`  | Expected lowercase hex SHA-256 (default: the `wolf_web.wasm` line of `<channel>/v<VERSION>/SHA256SUMS`). |
| `engine-format`  | `engineFormat`  | `docx`, `xlsx`, `pptx`, `pdf` or `auto`: load the release's smaller per-format module (see below).         |

A channel has the layout of the public installer:

```
<channel>/latest.txt                 1.4.0
<channel>/v1.4.0/SHA256SUMS          <hex>  wolf_web.wasm
<channel>/v1.4.0/wolf_web.wasm
```

To host the engine yourself, mirror that layout and set `engine-channel`, or
serve one module and set `engine-src` (with `engine-sha256` to keep the check).
Serve the module as `application/wasm` (needed for streaming compilation); a
versioned path can carry `Cache-Control: public, max-age=31536000, immutable`.
No COOP/COEP headers are needed (the engine is single-threaded). The `engine`
property also accepts a custom `fetch` (for authenticated hosting); the module
is then fetched with it.

An `EngineSource` can also name a `format` (`docx`, `xlsx`, `pptx` or `pdf`).
On a channel the release's slimmer `wolf_web_<format>.wasm` is then used when
its `SHA256SUMS` lists it, and the module for every format (`wolf_web.wasm`)
when it does not. An exact `engine-src` URL ignores `format`.

### Per-format modules

Set `engine-format` to pick a per-format module on a channel:

- Without it, the element loads `wolf_web.wasm` as soon as it is in the
  document, so `wolf-ready` fires before the first document.
- `engine-format="docx"` (or `xlsx`, `pptx`, `pdf`) loads `wolf_web_docx.wasm`
  at once, or `wolf_web.wasm` when the release's `SHA256SUMS` does not list
  the per-format module.
- `engine-format="auto"` loads the module of each document. With a `src` whose
  file name (or `name`) ends in `.docx`, `.xlsx`, `.pptx` or `.pdf`, that
  module loads at once. Without one, nothing downloads until `open`,
  `openReview`, `src`, the file picker or a drop provides a document; its bytes
  (`%PDF-`, or the `word/`, `xl/` or `ppt/` parts of a ZIP), then its name, tell
  the format, and `wolf-ready` fires once that module is ready. Opening a
  document of another format switches modules: the element starts a new engine
  with the same clock, mode, read-only state, theme and agents, then opens the
  document. A module compiled earlier on the page is reused, and a release
  without per-format modules keeps the running `wolf_web.wasm`.

`inferEngineFormat({ name, url, bytes })`, exported next to `ENGINE_FORMATS`,
applies the same detection for hosts that pick the format themselves.

### Extended font pack

A release can leave some faces out of its modules (Arabic, Armenian, Hebrew,
Thai, the Indic scripts and emoji) and serve them next to the module as
`v<VERSION>/fonts/<file>`, listed in `v<VERSION>/fonts/wolf_web_font_pack.json`
(schema `wolf-web-font-pack.v1`). When a page has text in one of those scripts
that the engine's face cannot draw, or a family the engine substituted that the
pack has, the element reads the manifest, downloads that face once per page,
checks its SHA-256 against the manifest before using it, draws a stand-in
meanwhile and repaints the page when the face arrives. A face with the wrong
checksum is never used. A host without the pack (the manifest answers 404)
draws as before. Mirror the `fonts/` directory with the module when you host
the engine yourself; the `engine` property's custom `fetch` also fetches the pack.

The element fetches, verifies and compiles the module once per source per page,
however many elements use it, and hands the compiled module to each element's
worker. A change to any engine attribute restarts the engine (closing the
document). Load failures fire `wolf-error` and show the fatal state with Retry:

| Code                     | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `channel-unreachable`    | `latest.txt` or `SHA256SUMS` could not be fetched, or `latest.txt` answered with an HTTP error.                      |
| `bad-version`            | The version (from `latest.txt` or `engine-version`) is not `MAJOR.MINOR.PATCH` with an optional pre-release suffix. |
| `bad-format`             | The `format` of an `EngineSource` is not `docx`, `xlsx`, `pptx` or `pdf`.                                            |
| `missing-checksum`       | `SHA256SUMS` is missing or lacks exactly one valid `wolf_web.wasm` line, or `engine-sha256` is not 64 hex digits.   |
| `checksum-mismatch`      | The module's SHA-256 differs from the expected one.                        |
| `http-error`             | The module could not be fetched or its body could not be read (network failure or HTTP error).                       |
| `module-download-failed` | The download failed before the module was received, for a reason none of the codes above covers.                    |
| `wasm-compile-failed`    | The bytes are not a WebAssembly module this browser can compile.           |
| `engine-incompatible`    | The module does not speak the engine interface this release expects.       |
| `kernel-closed`          | The worker stopped and the document on screen could not be restored.       |

The worker script (`assets/worker-*.js`) is loaded relative to `wolf-review.js`.
Serve it from the page's origin, or from another origin with CORS: browsers
refuse cross-origin worker URLs, so the element then starts the worker from a
same-origin `blob:` URL that imports the script (a CSP needs `worker-src blob:`).

Each element runs one long-lived engine instance; pages are drawn as vectors on
`<canvas>` from the engine's display lists (a page the vector path cannot draw
falls back to the engine's PNG). A crashed worker is replaced and its documents
restored. The Performance popover in the status bar names the module and its
version, the page drawing and the engine memory.

## Attributes

| Attribute      | Property      | Meaning                                                                                                                                                                                                                                                     |
| -------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`          | `src`         | Document to fetch and open once the engine starts, and whenever it changes.                                                                                                                                                                                 |
| `name`         | `name`        | File name for `src` (default: the last path segment).                                                                                                                                                                                                       |
| `clock`        | `clock`       | `live` (default: each edit runs at the current time in the browser's zone) or `pinned` (2026-01-01T00:00:00Z, UTC; byte-reproducible output). Applies in review and edit mode alike. Changing it restarts the engine, which closes the document.            |
| `mode`         | `mode`        | `review` (default; see Review mode) or `edit` (every plugin, toolbars and history). Any other value means `review`. Switching keeps the engine, its clock and the open document; only the plugin set and the review store's mode change.                  |
| `readonly`     | `readOnly`    | No plugin toolbars and no undo/redo buttons; every edit, undo, redo and history move is refused with error code `readonly`.                                                                                                                                 |
| `plugins`      | `plugins`     | Edit mode: space-separated subset of `docs slides sheets review` (default: all). An unknown name is reported as `plugin-unknown`.                                                                                                                           |
| `theme`        | `theme`       | `light`, `dark` or `auto` (default; follows `prefers-color-scheme`).                                                                                                                                                                                        |
| `unload-guard` | `unloadGuard` | Boolean, off by default. When set, the browser asks to confirm leaving the page while the document has unsaved edits. Without it the element never raises the page's leave prompt; a page that wants its own guard can track `wolf-change` and `wolf-save`. |

Read-only properties: `state` (the open document's `DocState` or null) and
`ready` (true after `wolf-ready`).

## Methods

All methods throw `KernelRequestError` with code `editor-not-started` while the
element is not in the document.

| Method                                         | Result                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open(data: Uint8Array \| Blob \| File, name)` | Open a document, replacing the current one.                                                                                                                                                            |
| `apply(ops: Op[])`                             | Apply one batch through the same host as the UI (history, selection, `wolf-change` with source `embed`). Resolves to `ApplyResult`; a refusal resolves `ok: false` and fires `wolf-error`.             |
| `undo()`, `redo()`                             | Move through the history.                                                                                                                                                                              |
| `save()`                                       | The current revision's bytes. No download, no `wolf-save`.                                                                                                                                             |
| `session()`                                    | The `SessionLog` of the open document, for native replay with `wolf transact`.                                                                                                                         |
| `close()`                                      | Close the document; the engine keeps running.                                                                                                                                                          |
| `openReview({ base, name, batches })`          | Open `base` as `open` does, then apply each batch in order as `apply` does (one history entry per batch, source `proposal`), a batch with `clock`/`timezone` at that time and zone; then shows the last batch applied with its changes outlined, scrolled to the first. See Review mode. |
| `submitReview()`                               | Submit as the review panel's Submit button does. Resolves `false` while a blocker stands or outside review mode, `true` once `wolf-review-submit` was handled.                                          |

## Events

All events bubble and are composed, so one listener on `document` hears every
element. `event.target` is the element.

| Event                | `detail`                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wolf-ready`         | `{ moduleUrl, version, sha256 }`: the module is fetched, verified and compiled; documents can open. `version` is null for a module given by `engine-src`, `sha256` when no checksum was given or published.        |
| `wolf-open`          | `{ name, format, pages, sha256 }`: a document opened (`open`, `src`, the file picker or a drop).                                                                                                                        |
| `wolf-change`        | `{ revision, sha256, ops, source }`: a batch was committed, or undo/redo moved the revision. `source` is the plugin id (`docs`, `slides`, ...), `embed`, `proposal`, `undo` or `redo`. `sha256` is the hash of what `save()` returns. |
| `wolf-save`          | `{ bytes, sha256, name }`: Save or Save as in the UI. Cancelable: `preventDefault()` keeps the bytes in the page and skips the download (and the Save as dialog).                                                       |
| `wolf-error`         | `KernelError` (`{ code, message, ... }`): an engine refusal, a load failure (see The engine), or an element error (`readonly`, `src-fetch-failed`, `plugin-unknown`, `plugin-load-failed`; for the last, `argument` names the plugin whose chunk did not load). |
| `wolf-selection`     | `{ addresses }`: the selected node addresses changed.                                                                                                                                                                   |
| `wolf-review-submit` | `{ bytes, sha256, name, session, decision }`: the reviewer submitted in review mode (see Review mode). Cancelable: `preventDefault()` skips the decision file download.                                                 |

The detail types are exported (`WolfReadyDetail`, `WolfOpenDetail`,
`WolfChangeDetail`, `WolfReviewSubmitDetail`, ..., plus `WolfMode`,
`WolfReviewInput`, `WolfReviewOpenResult` and `EngineSource`), and
`addEventListener` on the element is typed for these events.

## Review mode

`mode="review"` (the default) turns the element into a review workbench for
proposed changes. The plugin set is the review plugin alone (the `plugins`
attribute is ignored), the plugin toolbars and the undo and redo buttons are
hidden, and the Review side panel is selected once a document opens. The
reviewer approves or rejects each hunk (the changes one operation caused);
rejecting rebuilds the document from the kept operations and refuses when a
rejection would change what a kept operation does. `readonly` still wins: with
both set, every review action that edits is refused with `readonly`.

A workbook opens in review mode as a read-only sheet grid: the sheets of the
revision on screen as tabs, with the cells that proposed changes touched marked
by the reviewer's decision (undecided, approved or rejected) and a count of them
on each tab. Selecting a change in the Review panel selects its cell and scrolls
to it, and clicking a marked cell selects its change. The Sheet Grid and Printed
Pages buttons above the grid switch to the engine's printed pages. The grid shows
up to 2000 rows and 200 columns of a sheet (every changed cell is included, and
"Show more" reads further); Printed Pages shows the whole sheet.

Review mode runs on the element's `clock` like edit mode: `live` (the default)
or `pinned`. Every batch of the session log records the clock and zone it ran
at (`session()`: the session's `clock`/`timezone`, and a batch's own when it
differs), and a rejection rebuilds each later batch at its recorded clock, so
the submitted bytes replay exactly from the log under either clock. A host that
needs the same bytes for the same review on every run, whenever and wherever it
happens, sets `clock="pinned"`; under `live` an operation whose result depends
on the time (a `TODAY()` cell value, a comment without an explicit date) gets
the time it ran at.

Hand the element the base document and the proposed batches with
`openReview({ base, name, batches })`. Each batch is an `Op[]` or
`{ ops, label, clock, timezone }` (default label `Proposed change <n>`). `clock`
(a UTC instant, `YYYY-MM-DDTHH:MM:SSZ`) and `timezone` (an IANA zone name) are
optional: a batch that has either runs at that time and zone instead of the
element's (`ApplyOptions.at`; the missing one comes from the element), so a
proposal produced elsewhere at known times reproduces its bytes in a live-clock
review. It resolves to `{ applied, refused }`: it stops at the first refused
batch and reports its `index` and `error` (the earlier batches stay applied;
`wolf-error` fires as for `apply`); `refused` is null when every batch applied.
It rejects when `base` does not open. The last batch applied is then inspected
as a click on its row in the changes panel does: its changes are outlined (a
slide table cell in its own box) and the pages scroll to the first of them, so
a change on slide 3 of a deck or on the second sheet of a workbook is in view
when the review opens.

Submit (the panel's button, or `submitReview()`) is refused while no document is
open, a change is undecided, a rejection is still running, a rejection was
refused as coupled to a kept change, the reviewer has stepped back from the
newest kept revision, or the package holds part changes that no reviewed change
explains and the reviewer has not acknowledged. Otherwise the element fires
`wolf-review-submit` with `bytes` (the current revision, holding only approved
changes), `sha256`, `name`, `session` (as `session()`) and `decision` (the
review decision file, contract `wolfsuite.review-decision.v1`). Without
`preventDefault()` the decision file downloads instead.

In `decision`, each entry lists `hunks` (one per proposed operation, with its
decision and the changes it produced) and `rejected_ops` (operations the
reviewer removed, at their index in the batch as proposed). `decision.parts`
holds the result of comparing the current package with the original outside the
engine: `unexplained` names every part that changed without a reviewed change
naming it, each with `acknowledged`. The review panel's export of the whole
session uses contract `wolfsdk.review-session.v1`, whose JSON schema is
`https://wolfsdk.com/schemas/review-session.v1.schema.json`; both schemas and
their validators are exported from `@wolfsdk/review/protocol`.

```js
const review = document.querySelector("wolf-review");
const base = await (await fetch("/files/report.docx")).blob();
const { batches } = await (await fetch("/proposals/report.json")).json();
const { refused } = await review.openReview({ base, name: "report.docx", batches });
if (refused) console.warn(`Proposed change ${refused.index + 1} was refused: ${refused.error.message}`);
review.addEventListener("wolf-review-submit", async (event) => {
  event.preventDefault(); // the page keeps the result; no download
  const { bytes, ...result } = event.detail; // sha256, name, session, decision
  await fetch("/review", { method: "POST", body: JSON.stringify(result) });
  await fetch(`/review/${result.sha256}`, { method: "PUT", body: bytes });
});
```

The bytes come from a browser, so a server must not trust them as they are.
Replay `detail.session` with native `wolf transact` (every batch with its
recorded clock and zone), check that the replay's SHA-256 equals
`detail.sha256` and that the SHA-256 of `detail.bytes` equals it too, and keep
the replay's output (or the bytes, once both match). The clocks in the log come
from the browser. Replaying the server's own copy of the proposed operations
with them is still a proof: the engine's output depends only on the base, the
operations, the clock, zone, locale and seed, so a clock that reproduces the
posted SHA-256 from operations the server trusts proves the bytes, whatever time
it names.

## React

```tsx
import { useRef } from "react";
import { WolfReview, type WolfReviewElement } from "@wolfsdk/review/react";

function Review({ base, batches }: { base: Blob; batches: unknown[] }) {
  const ref = useRef<WolfReviewElement>(null);
  return (
    <WolfReview
      ref={ref}
      engineVersion="1.4.0"
      style={{ height: 720 }}
      onReady={() => void ref.current?.openReview({ base, name: "report.docx", batches })}
      onReviewSubmit={(event) => {
        event.preventDefault();
        void upload(event.detail);
      }}
    />
  );
}
```

Props mirror the attributes in camel case (`engineSrc`, `engineChannel`,
`engineVersion`, `engineSha256`, `src`, `name`, `clock`, `mode`, `readOnly`,
`plugins` as a string or a list, `theme`, `unloadGuard`) plus `engine`
(an `EngineSource`), `id`, `className` and `style`. Each event has an `on*`
prop: `onReady`, `onOpen`, `onChange`, `onSave`, `onError`, `onSelection`,
`onReviewSubmit`. The ref is the element, so every method above is available on
`ref.current`. An `engine` with a custom `fetch` reaches the element after
mount, so the element restarts its engine once with it.

## Styling and isolation

The element's CSS is never added to the page: each shadow root adopts one
shared constructed stylesheet. Inherited page styles (font, colour, line
height, letter spacing, ...) stop at the shadow boundary.

Page rules on the element itself set its box: the default is `display: block;
height: 600px; overflow: hidden`. Do not give the element (or an ancestor)
`transform`, `filter` or `contain`: those make it the containing block of the
UI's `position: fixed` menus and popovers.

Colours are themable from the page through custom properties on the element,
which inherit into the shadow root: `--wolf-<token>` for the light theme and
`--wolf-dark-<token>` for the dark theme, for example
`<wolf-review style="--wolf-accent: #0a7; --wolf-dark-accent: #3c9">`. The
tokens are the custom properties at the top of the element's stylesheet
(`wolf-review.css`).

The element writes nothing to `document.title` or `localStorage` (panel sizes
stay in memory). Its keyboard shortcuts (the `?` table, Ctrl/Cmd+Z, ...) act
only on keys pressed inside it: a key typed on the page, or in another element,
does nothing here. A key the element handled reaches page listeners with
`defaultPrevented` set.

The shell's own surfaces live inside the shadow root: the empty state and the
open-problem notices, the shortcut table (`?`), the polite live region (opens,
saves, undo and redo), the Fonts and licences sheet and the Performance
popover. Below 760 px of element width (not window width) the rail and side
panel float as overlays instead of docking.

## Limitations

- In review mode an element narrower than 760 px keeps the side panel closed
  until the reviewer opens it.
- Switching `mode` between `review` and `edit` remounts the shell, so zoom and
  the selected side-panel tab start over.
- The review plugin's sheet grid is read-only and shows at most 2000 rows and
  200 columns of a sheet; use Printed Pages for the rest.
- A plugin chunk that fails to load (`plugin-load-failed`) leaves the element
  running with the plugins that did load; changing `mode`, `plugins` or
  `readonly` tries again.
- One worker per element; each holds its own engine instance.

## Building this package

In the repository (`sdk/web`, a bun workspace):

```sh
bun install
bun run --cwd packages/review build   # dist/: the package as published (JS, worker, CSS, types, package.json)
bun run --cwd packages/review pack    # build, then pack/wolfsdk-review-<version>.tgz
bun run --cwd packages/review check   # build, pack and check the tarball as a consumer gets it
```

The workspace manifest points at the TypeScript sources and is private; the
build writes the publish manifest into `dist/`, so the package is published
from `dist/`. `dist/sizes.json` has the raw and gzip size of every file of the
last build, and the gzip size of the review entry, its stylesheet and the lazy
plugin chunks.

## License

MIT. See `LICENSE`.
