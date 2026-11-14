# WolfSDK web workspace

The browser side of WolfSDK: one custom element, `<wolf-review>`, that opens a DOCX, XLSX or
PPTX, shows it, edits it through the engine and exports a review session. The engine is the
`wolf-web` WebAssembly module fetched from the WolfSDK release channel (`https://wolfsdk.com/download/wolf`); nothing here
reimplements format logic.

## Packages

|Path|Package|What it is|
|---|---|---|
|`packages/protocol`|`@wolfsdk/protocol`|The engine contract: request and reply types, operations, workspace room messages, the review session record (`wolfsdk.review-session.v1`), its JSON schema and validators. MIT; no runtime dependencies.|
|`packages/runtime`|`@wolfsdk/runtime`|The reactor client (worker in the browser, in-process in Node), the engine loader that resolves a module from the release channel and verifies its SHA-256, and the seal helpers. Apache-2.0.|
|`packages/review`|`@wolfsdk/review`|The `<wolf-review>` element, an auto-registering entry, a React wrapper and the styles. Published to npm under MIT.|
|`packages/server`|`@wolfsdk/server`|Multi-party workspace rooms, SQLite append-only op log, content-addressed blob store, seat enforcement, and `wolf reactor-serve` worker pool. Apache-2.0.|
|`packages/mcp`|`@wolfsdk/mcp`|Model Context Protocol server (stdio and Streamable HTTP) exposing the 8 workspace tools and `wolf://workspace/{id}` resource. Apache-2.0.|
|`packages/packs`|`@wolfsdk/packs`|`pack.wolf.json` freshness check and refresh across DOCX bookmarks/tables and PPTX tables, headlines, and chart series from XLSX, CSV, and SQL snapshots. Apache-2.0.|
|`packages/workspace-cli`|`@wolfsdk/workspace`|The `wolfsdk-workspace` CLI (`check`, `refresh`, `serve`) over the workspace room server and pack engine. Apache-2.0.|
|`apps/playground`|`@wolfsdk/playground`|A local page that mounts the element beside the inspection modes. Never published.|

`@wolfsdk/protocol` and `@wolfsdk/review` are MIT; the root workspace and remaining packages are
Apache-2.0. `@wolfsdk/review` bundles what it needs from `@wolfsdk/protocol` and `@wolfsdk/runtime`
and publishes from `packages/review/dist`.

## Commands

Run from the repository root with [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun run typecheck      # tsc for every package and app
bun test               # unit tests for every package and app
bun run build          # build @wolfsdk/review into packages/review/dist
bun run check          # typecheck, tests, then the @wolfsdk/review package check
bun run gate           # frozen install, then check: the one command a lane gate runs from a clean checkout
```

Two checks need an engine module (see below):

```sh
bun run --cwd packages/runtime smoke    # open, edit, save and export a session for DOCX, XLSX, PPTX
bun run --cwd apps/playground dev       # the playground on http://localhost:5410
```

The package check (`packages/review/scripts/check.ts`) builds and packs the tarball, then
refuses it unless it carries the MIT licence, holds no `.wasm`, source map or source file,
defaults to the release channel, and its declarations compile in a consumer project.

## The engine module

`@wolfsdk/review` never bundles the engine. At run time it fetches the module from the release
channel (`https://wolfsdk.com/download/wolf` by default), or from an exact URL given with its
SHA-256, and verifies the bytes before compiling them. The module's licence is separate from
this workspace's MIT licence.

For local work, put a module at `vendor/wolf_web.wasm`. The directory is ignored by
Git: a module is tens of megabytes and is never committed or packed. Build one from the
repository root on a gate host:

```sh
python3 scripts/build_wolf_web.py --out-dir sdk/web/vendor
```

The smoke script and the playground's dev server read `vendor/wolf_web.wasm`; the unit tests
need no module. A module that lacks an optional command answers `unsupported`; the element
reports the refusal and disables the control that issued it for the rest of the session.

A module built from `main` on 2026-11-13 opens, renders, saves and exports sessions for all
three formats and applies the engine's Agent API operations (`set`, `replace-text`, `insert`,
`delete`, `format` and the rest). It refuses the operations the element's editors add on top:
typing in a DOCX (`splice-text`, `split-paragraph`, `join-paragraph`, `set-list`), moving and
resizing a PPTX shape, and the XLSX grid operations. They land with
current Wolf Runtime releases, current Wolf Runtime releases and
current Wolf Runtime releases; until then those controls report the refusal. The
smoke script uses one operation per format that a module from `main` accepts.

## Fixtures

`fixtures/` holds one small file per format for the smoke script. Tests that need recorded
engine replies keep them beside the test.
