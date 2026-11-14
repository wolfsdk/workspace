# Wolf Review Playground

A private app for trying Wolf Review on your own files. It is never published.

Modes, in tab order:

- Review: the `<wolf-review>` element on a picked file, with the events it raises.
- Mangle-Off: one edit made by Wolf and by a Python library (openpyxl,
  python-docx or python-pptx) running in the browser, with the package parts
  each one rewrote. The comparison checks which package parts changed, so it
  can miss a loss inside a part that is otherwise kept.
- X-ray: text a parser hands a model that the reader never sees on the page.
- Recalc: workbook cells whose stored value differs from a fresh calculation.

## Commands

Run from `sdk/web` after `bun install`:

```sh
bun run --cwd apps/playground dev        # dev server on port 5410 (PLAYGROUND_PORT)
bun run --cwd apps/playground build      # static build in apps/playground/dist
bun run --cwd apps/playground typecheck
bun run --cwd apps/playground test
```

Set `PLAYGROUND_BASE` to build for a sub-path (default `/`).

`dev` and `build` first build `@wolfsdk/review`: the page mounts the built
package, as an embedder does, so restart `dev` after changing the element.

## Engine

In dev, when `vendor/wolf_web.wasm` exists, the server serves it at
`<base>engine/wolf_web.wasm` and the app offers it as the first engine choice.
Otherwise, and always in a build, the app loads the latest release from
`https://wolfsdk.com/download/wolf` and checks its sha256 against the
channel's `SHA256SUMS`.

## Network

The Mangle-Off mode fetches its Python runtime on first use. Every file below is
pinned by sha256 and size in `src/rivals/sources.ts`; a file whose bytes do
not match is refused.

Served by this app from the `pyodide` npm package (exactly 0.29.5, MPL-2.0) at
`<base>pyodide/0.29.5/`:

- `pyodide.mjs`, `pyodide.asm.js` (loaded as scripts)
- `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`

Fetched from `cdn.jsdelivr.net` (`/pyodide/v0.29.5/full/`):

- `lxml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl`
- `pillow-11.3.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl`
- `typing_extensions-4.15.0-py3-none-any.whl`

Fetched from `files.pythonhosted.org`:

- `openpyxl-3.1.5-py2.py3-none-any.whl`
- `et_xmlfile-2.0.0-py3-none-any.whl`
- `python_docx-1.2.0-py3-none-any.whl`
- `python_pptx-1.0.2-py3-none-any.whl`
- `xlsxwriter-3.3.1-py3-none-any.whl`

The Python worker itself makes no network request: the page fetches and checks
these files and hands the worker their bytes.
