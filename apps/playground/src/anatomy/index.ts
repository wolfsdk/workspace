import type { AnatomyMapProps, ByteRibbonProps, LegendProps } from "../lab/index.ts";
import type { ComponentType } from "preact";
import { AnatomyMap as AnatomyMapView } from "./AnatomyMap.tsx";
import { ByteRibbon as ByteRibbonView } from "./ByteRibbon.tsx";
import { Legend as LegendView } from "./Legend.tsx";

export const AnatomyMap: ComponentType<AnatomyMapProps> = AnatomyMapView;
export const ByteRibbon: ComponentType<ByteRibbonProps> = ByteRibbonView;
export const Legend: ComponentType<LegendProps> = LegendView;
export { createGeiger } from "./geiger.ts";

export {
  changedSpans,
  isChangedSegment,
  layoutTreemap,
  ribbonSegments,
  squarify,
  treemapItems,
  type Rect,
  type RibbonSegment,
  type TreemapCell,
  type TreemapGroup,
  type TreemapItem,
  type TreemapLayout,
  type TreemapOptions,
} from "./layout.ts";
export { ROLE_LABEL, ROLE_ORDER, memberRole, type AnatomyRole } from "./roles.ts";
export { VERDICT_TEXT, formatBytes, formatShare, untouchedLabel } from "./verdicts.ts";
