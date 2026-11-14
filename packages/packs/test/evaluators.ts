// Stand-ins for the engine in the tests of the packs package: an evaluator that returns the workbook a function
// makes of the bytes it is given, and a document engine that applies a batch with the package's own applier.
import type { RoomBatch } from "@wolfsdk/protocol/workspace";
import type { DocumentEngine, ReplayInput, ReplayResult } from "@wolfsdk/server";
import { DocxDocument } from "../src/docx.ts";
import type { XlsxEvaluator } from "../src/evaluator.ts";
import { PptxDocument } from "../src/pptx.ts";
import { sha256 } from "./fixtures.ts";

export function evaluatorFor(recalculate: (bytes: Uint8Array) => Uint8Array): XlsxEvaluator {
  return { recalculate: async ({ bytes }) => recalculate(bytes) };
}

/** An engine that edits a document by the same appliers `refreshPack` uses without one, and records what it was asked. */
export class LocalEngine implements DocumentEngine {
  readonly replays: { name: string; batches: readonly RoomBatch[] }[] = [];

  async entitlement() {
    return { tier: "community", max_workspaces: null, max_seats: null, sso: false, oem_offline_wasm: false, key_id: null, expires_at: null } as const;
  }

  async replay(input: ReplayInput): Promise<ReplayResult> {
    this.replays.push({ name: input.name, batches: input.batches });
    let bytes = input.bytes;
    const steps: ReplayResult["steps"] = [];
    for (const batch of input.batches) {
      const before = sha256(bytes);
      const doc = input.format === "docx" ? new DocxDocument(bytes, input.name) : new PptxDocument(bytes, input.name);
      doc.apply(batch.ops);
      bytes = doc.save();
      steps.push({ base_sha256: before, sha256: sha256(bytes) });
    }
    return { format: input.format, base_sha256: sha256(input.bytes), steps, bytes: input.save ? bytes : null, page_hashes: input.pages ? [sha256(bytes)] : null };
  }

  async close(): Promise<void> {}
}
