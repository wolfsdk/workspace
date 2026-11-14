// The built-in document readers: deterministic, dependency-free parsers of the packages a workspace holds.
// They let `doc_read` and `doc_search` work on any room, with no engine process behind it.
import type { WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import { openDocx } from "./docx.ts";
import type { ReadableDocument } from "./model.ts";
import { openPdf } from "./pdf.ts";
import { openPptx } from "./pptx.ts";
import { openXlsx } from "./xlsx.ts";

export { blankDocument } from "./blank.ts";
export * from "./model.ts";
export { ZipArchive, ZipError, writeZip } from "./zip.ts";

/** Parse `bytes` as a document of `format`. Throws `ReadError` (`invalid-input`) when they are not one. */
export function readDocument(format: WorkspaceDocFormat, bytes: Uint8Array): ReadableDocument {
  switch (format) {
    case "docx":
      return openDocx(bytes);
    case "xlsx":
      return openXlsx(bytes);
    case "pptx":
      return openPptx(bytes);
    case "pdf":
      return openPdf(bytes);
  }
}
