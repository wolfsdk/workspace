# Fixtures of the engine checks

Files the six engine-backed checks of `@wolfsdk/review` open (`bun packages/review/scripts/engine-checks.ts`).
Together with `docx/tiny.docx`, `pptx/tiny.pptx` and `xlsx/names-tables.xlsx` (see `README.md`) these are the inputs of
the checks. The four office files are copied unchanged from documents that already live in this repository (the
SHA-256 of each copy equals its source); the three session files are recorded op batches. Paths in "Source" are
relative to the repository root.

| File | Bytes | SHA-256 | Source | Used by |
| --- | ---: | --- | --- | --- |
| `docx/images-hdrftr.docx` | 15408 | `0c88d23f6999104080ef9e445fb2aab18dabc29c8fe24b88f8072d633622cdea` | `engines/wolfdocx/crates/wolfdocx-odt-writer/tests/fixtures/docx/report-annual-clean.docx` | base of the DOCX session; 8 pages, 2 inline images, headers and footers, 3 sections, a table, bullets |
| `pptx/deck-13.pptx` | 80110 | `2365c1493918c3d8962b0f615ad8469bf1fbce1df73ff8c930f0c54c0c8b861d` | `engines/wolfppt/fixtures/pptx/workloads/large_real_world_deck.pptx` | base of the PPTX session; 13 slides, 4 tables, 4 charts, a picture, notes |
| `xlsx/chart-line.xlsx` | 5667 | `26ebe76bf7ca2a7c35ad5e7b24dc84a74ec453a27bb95345ad3b51ac94878755` | `engines/wolfxl/tests/fixtures/render/chart_line.xlsx` | `unexplained-parts` (a workbook with a shared strings part) |
| `xlsx/model-finance.xlsx` | 9016 | `cace063417422dba0ff6db8236e7554d7afb68965c6084445b5542708f9f23e7` | `commercial/drafts/account-prep-20261026-labs/proofs/shortcut-finance-workflow/inputs/model.xlsx` | `unexplained-parts` (a workbook with defined names) |
| `docx/sessions/session-20.json` | 3603 | `2094a1eb07440149741bdbf75580f9b36b56f6783b42ae4a0fd8954acf0652c1` | recorded batches for `docx/images-hdrftr.docx` | all six checks |
| `pptx/sessions/session-20.json` | 5411 | `ffb68b817e3ce4a174aab20e862749634565a2cf7cd9ec295bcce39c3f9a5072` | recorded batches for `pptx/deck-13.pptx` | all six checks |
| `xlsx/sessions/session-20.json` | 2029 | `9cf97ad30f344ab1726ae7087784639c6b7c3cc97c0d73d611e0b02e21727f3b` | recorded batches for `xlsx/names-tables.xlsx` | all six checks |

A session file holds 20 batches (an array of op arrays, or of `{name, ops}` objects for PPTX) that a module built from
`main` applies in order to its base file. Replay them against a different base and the targets will not resolve.
