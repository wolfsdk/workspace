// A `WorkspaceDocInspector` backed by engine workers: the `text` and `markdown` views of a whole document come
// from the engine's own extractors, which read every format the engine opens. Anything else (a `target`, the
// `structure` and `cells` views) is declined, and the built-in reader answers it.
import { ask, type EnginePool, withOpenDocument } from "./engine.ts";
import type { DocContent, InspectRequest, WorkspaceDocInspector } from "./hooks.ts";

const SUFFIX = { text: ".txt", markdown: ".md" } as const;
const decoder = new TextDecoder();

export function engineInspector(pool: EnginePool): WorkspaceDocInspector {
  return {
    async read(request: InspectRequest): Promise<DocContent | undefined> {
      const { view } = request;
      if (request.target !== undefined || (view !== "text" && view !== "markdown")) return undefined;
      return withOpenDocument(pool, request, async (worker, doc) => {
        const { body, segments } = await ask(worker, { cmd: "extract", doc, options: { what: [view] } });
        if (!body.ok) return undefined;
        const output = body.outputs?.find((candidate) => candidate.path.endsWith(SUFFIX[view]));
        const blob = output ? segments[output.data.bin] : undefined;
        return blob ? { view, text: decoder.decode(blob) } : undefined;
      });
    },
  };
}
