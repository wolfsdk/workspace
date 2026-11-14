import type { CodeDrawerProps } from "../lab/index.ts";
import type { ComponentType } from "preact";
import { CodeDrawer as Drawer } from "./CodeDrawer.tsx";

/** `toBatches`: the effective batches (rejected and conflicted steps left
 * out), in the `SessionLog` shape that the TypeScript recipe reads.
 * `toCli`, `toPython`, `toMcp`, `toTypeScript`: replay recipes that
 * end in a sha256 check against `journal.resultSha256`. */
export { toBatches, toCli, toMcp, toPython, toTypeScript } from "./emit.ts";
export const CodeDrawer: ComponentType<CodeDrawerProps> = Drawer;
