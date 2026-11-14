# @wolfsdk/packs

Check and refresh a Wolf Workspace pack: a directory with a `pack.wolf.json` manifest
(contract `wolfsdk.pack.v1`, validated by `@wolfsdk/protocol/workspace`), the spreadsheet,
CSV or SQL snapshot sources it reads, and the Word and PowerPoint documents it writes to.

Apache-2.0. Private until it is published on purpose. Depends on `@wolfsdk/protocol` and
`@wolfsdk/server` and nothing else; it reads and writes OOXML itself (ZIP, XML, number
formats, A1 addresses), so a pack refresh needs no engine process.

## What a refresh does

A binding links a selector in a source (`cell`, `range`, `table`, `defined_name`) to a target
in a document:

|Target kind|Address|Fit policies|
|---|---|---|
|`docx_table`|`<table name>`|`none`, `grow`, `truncate`, `fail`|
|`docx_bookmark`|`<bookmark name>`|`none`, `truncate`, `fail`|
|`pptx_table`|`slide:@N/shape:<name>`|`none`, `grow`, `truncate`, `fail`|
|`pptx_chart_series`|`slide:@N/shape:<name>/chart/series:<name or @N>`|`none`, `fail`|
|`pptx_fit_headline`|`slide:@N/shape:<name>`|`none`, `shrink_to_fit`, `truncate`, `fail`|

A value is formatted the way the source cell is displayed (its number format, the source's
locale, its 1900 or 1904 date base) unless the binding names its own `number_format`. A
snapshot source names the SHA-256 of its snapshot; a snapshot with other bytes refuses the
pack. Every source carries its own determinism (clock, seed, timezone, locale), so the same
inputs give the same bytes on any machine.

The planner reads every source and target once and answers, per target document, with one
batch of agent-api ops (`set`, `insert-row`). A binding whose ops are
empty is fresh.

- `checkPack(store)` is that plan: which bindings are stale, how many ops each needs.
  It writes nothing.
- `refreshPack(store, { engine?, evaluator? })` applies the batches, reads its own result
  again, and writes only when every binding is fresh. A refresh that is not a fixed point
  throws `refresh-did-not-converge`. Any refused binding refuses the whole pack
  (`pack-refused`, with one problem per binding) and nothing is written: the write is one
  staged set of files, renamed into place together. A second refresh changes no byte.
- `refreshPackInRoom(service, roomId, actor, manifest, { sources, mode })` sends the same
  batches to a room as `commit` or `propose` edits, each against the revision it was read at,
  so a document someone else changed meanwhile is a `REVISION_MISMATCH` and the edits after
  it are not sent.

A table that is too small grows by chained `insert-row` ops at the tail (`row:@N`,
`row:@N+1`, ...), so a batch is valid in order whatever the engine's row bookkeeping is.

## Stores, engine and evaluator

`DirectoryStore` is a pack on disk (names are relative to the directory and may not leave
it); `MemoryStore` is one in memory. Both implement `PackStore`.

Without options the package applies the batches with its own appliers. With `engine` (any
`DocumentEngine` of `@wolfsdk/server`, for example `PoolEngine` over the `wolf reactor-serve`
workers) it replays one batch per document under the determinism of the pack and writes the
bytes the engine returns. With `evaluator` (`PoolXlsxEvaluator`) an XLSX source is
recalculated under its determinism before it is read; without one the cached value of every
formula cell is what is read.

## Errors

Every failure is a `PackError` with a stable `code` and, when it belongs to one binding,
`binding_id`, `target_doc` and `target_address`; `problems` lists all of them for a refusal.
Codes include `manifest-missing`, `manifest-invalid`, `pack-refused`,
`refresh-did-not-converge`, `target-missing`, `source-unknown`, `unknown-sheet`,
`address-unresolved`, `selector-shape`, `non-numeric-value`, `invalid-text`,
`table-overflow`, `text-does-not-fit`, `snapshot-sha256-mismatch`, `path-outside-pack`,
`package-bad-zip` and `engine-no-bytes`.

## Tests

```sh
bun test            # from this directory
```

The documents the tests need are built in memory (`test/fixtures.ts`); no archive is
committed.
