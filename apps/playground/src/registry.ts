import type { LabMode } from "./lab/index.ts";
import { mode as mangleOff } from "./modes/mangle-off/index.tsx";
import { mode as recalc } from "./modes/recalc/index.tsx";
import { mode as review } from "./modes/review/index.tsx";
import { mode as xray } from "./modes/xray/index.tsx";

/** Display order of the modes. */
export const PLAYGROUND_MODES: LabMode[] = [review, mangleOff, xray, recalc];
