// The linked pack as the `PackRefresher` of the MCP tools: `pack_link_refresh` plans the pack of `--pack <dir>`
// against the documents of the agent's room and sends each stale target one batch through the room service, so
// a refresh is a proposal a person decides (or a commit, where the room lets the agent commit).
//
// The manifest is read from the pack directory on every call. A source is read from the room when the room holds
// a document of that name, so what an agent refreshes from is the workbook the room shows, and from the pack
// directory otherwise. Targets are always the documents of the room.
import { PackRefreshError, type PackBindingRefresh, type PackRefresher, type PackRefreshRequest, type PackRefreshResult, type PackSummary } from "@wolfsdk/mcp";
import { DirectoryStore, loadPack, PackError, refreshPackInRoom, type PackReader, type RoomRefreshReport, type XlsxEvaluator } from "@wolfsdk/packs";
import type { PackManifest } from "@wolfsdk/protocol/workspace";

export type DirectoryPackRefresherOptions = {
  /** The pack directory (`pack.wolf.json` and the sources the room does not hold). */
  dir: string;
  /** Recalculates XLSX sources; without it the cached values are read. */
  evaluator?: XlsxEvaluator;
};

/** The sources of a pack for one room: the room's document of that name, else the file of the pack directory. */
function roomFirst(request: PackRefreshRequest, store: PackReader): PackReader {
  return {
    read: async (name) => {
      const head = await request.roomService.readHead(request.roomId, request.actor, name);
      if (head.ok) return head.value.bytes;
      if (head.error.code !== "UNKNOWN_DOCUMENT") throw new PackError("room-read-failed", `${name}: ${head.error.code}: ${head.error.message}`);
      return store.read(name);
    },
  };
}

/** What each binding of `manifest` came to, from the plan and the edits the room answered. */
function outcomes(manifest: PackManifest, refreshed: RoomRefreshReport): PackBindingRefresh[] {
  const edits = new Map(refreshed.edits.map((edit) => [edit.doc_name, edit.result]));
  const stopped = refreshed.edits.find((edit) => !edit.result.ok)?.doc_name;
  return refreshed.report.bindings.map((binding): PackBindingRefresh => {
    if (binding.status === "fresh") return { binding: binding.binding_id, status: "unchanged", doc: binding.target_doc };
    const result = edits.get(binding.target_doc);
    if (result === undefined) {
      return { binding: binding.binding_id, status: "failed", doc: binding.target_doc, message: `not sent: the refresh of pack ${manifest.pack_id} stopped at ${stopped ?? "an earlier document"}` };
    }
    if (!result.ok) return { binding: binding.binding_id, status: "failed", doc: binding.target_doc, message: `${result.error.code}: ${result.error.message}` };
    return result.value.mode === "propose"
      ? { binding: binding.binding_id, status: "updated", doc: binding.target_doc, proposal_id: result.value.proposal.proposal_id }
      : { binding: binding.binding_id, status: "updated", doc: binding.target_doc, revision: result.value.head.revision };
  });
}

/** A `PackRefresher` over the pack directory `options.dir`. */
export function directoryPackRefresher(options: DirectoryPackRefresherOptions): PackRefresher {
  const store = new DirectoryStore(options.dir);

  async function manifestOf(): Promise<PackManifest> {
    try {
      return await loadPack(store);
    } catch (e) {
      if (e instanceof PackError) throw new PackRefreshError(`${e.code}: ${e.message}`);
      throw e;
    }
  }

  return {
    /** The linked pack, or nothing while its manifest cannot be read: `pack_link_refresh` says why. */
    async listPacks(): Promise<PackSummary[]> {
      try {
        const manifest = await loadPack(store);
        return [{ pack: manifest.pack_id, bindings: manifest.bindings.map((binding) => binding.id), title: manifest.name }];
      } catch (e) {
        if (e instanceof PackError) return [];
        throw e;
      }
    },

    async refreshPack(request: PackRefreshRequest): Promise<PackRefreshResult> {
      const manifest = await manifestOf();
      if (request.pack !== manifest.pack_id) throw new PackRefreshError(`no pack ${JSON.stringify(request.pack)}: this server links the pack ${JSON.stringify(manifest.pack_id)}`);
      const wanted = request.bindings;
      const unknown = wanted?.filter((id) => !manifest.bindings.some((binding) => binding.id === id)) ?? [];
      if (unknown.length > 0) throw new PackRefreshError(`the pack ${manifest.pack_id} has no binding ${unknown.map((id) => JSON.stringify(id)).join(", ")}`);
      const selected: PackManifest = wanted === undefined ? manifest : { ...manifest, bindings: manifest.bindings.filter((binding) => wanted.includes(binding.id)) };
      try {
        const refreshed = await refreshPackInRoom(request.roomService, request.roomId, request.actor, selected, {
          sources: roomFirst(request, store),
          mode: request.mode,
          evaluator: options.evaluator,
        });
        return { pack: manifest.pack_id, mode: request.mode, bindings: outcomes(selected, refreshed) };
      } catch (e) {
        if (!(e instanceof PackError)) throw e;
        // A refusal names the bindings it refused and has sent nothing to the room.
        const refused = new Map(e.problems.flatMap((problem) => (problem.binding_id === undefined ? [] : [[problem.binding_id, problem] as const])));
        if (refused.size === 0) throw new PackRefreshError(`${e.code}: ${e.message}`);
        return {
          pack: manifest.pack_id,
          mode: request.mode,
          bindings: selected.bindings.map((binding): PackBindingRefresh => {
            const problem = refused.get(binding.id);
            return problem === undefined
              ? { binding: binding.id, status: "unchanged", doc: binding.target_doc, message: "not sent: the pack refused other bindings, so nothing was written" }
              : { binding: binding.id, status: "failed", doc: binding.target_doc, message: `${problem.code}: ${problem.message}` };
          }),
        };
      }
    },
  };
}
