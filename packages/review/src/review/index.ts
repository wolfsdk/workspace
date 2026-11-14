import type { EditorPlugin } from "../host/index.ts";
import { SheetReviewView } from "./SheetReviewView.tsx";
import { ReviewOverlay } from "./overlay.tsx";
import { SHORTCUTS, handleGlobalKey } from "./keys.ts";
import { ChangesPanel } from "./panel.tsx";
import "./style.css";

export const reviewPlugin: EditorPlugin = {
  id: "review",
  PageOverlay: ReviewOverlay,
  MainView: SheetReviewView,
  mainViewFormats: ["xlsx"],
  sidePanels: [{ id: "review", title: "Review", Component: ChangesPanel }],
  onKeyDown: handleGlobalKey,
  shortcuts: SHORTCUTS,
};

export type { Decision, DecisionDoc, Hunk, PartFinding, PartsReport, SessionEntry, SessionExport } from "@wolfsdk/protocol";
export type {
  Coupling,
  CoupledNotice,
  PartsCheck,
  RejectOnlyResult,
  RejectOpsResult,
  ReviewStore,
  SubmitBlocker,
} from "./store.ts";
export { reviewStore } from "./store.ts";
