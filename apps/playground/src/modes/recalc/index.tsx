/** @jsxImportSource preact */
import type { LabDoc, LabEngine, LabMode, ModeProps } from "../../lab/index.ts";
import { useEffect, useState } from "preact/hooks";
import { DEFAULT_SORT, recalcAccess, type SortOrder } from "./model.ts";
import "./recalc.css";
import { kernelError, recalcStore, useRecalcRun } from "./store.ts";
import { RecalcRailView, RecalcStageView, type StageImage } from "./view.tsx";

/** Raster scale for the page: two pixels per point keeps cell text sharp. */
const PX_PER_PT = 2;

function usePageImage(engine: LabEngine, doc: LabDoc, page: number, enabled: boolean): StageImage {
  const [image, setImage] = useState<StageImage>({ phase: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let url: string | null = null;
    setImage({ phase: "loading" });
    engine.pageImage(doc, page, PX_PER_PT).then(
      (raster) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([raster.png], { type: "image/png" }));
        setImage({ phase: "ready", url, widthPt: raster.widthPt, heightPt: raster.heightPt, regions: raster.regions });
      },
      (error: unknown) => {
        if (live) setImage({ phase: "error", ...kernelError(error) });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [engine, doc.id, doc.sha256, page, enabled]);
  return image;
}

function Stage(props: ModeProps) {
  const { engine, doc } = props;
  const access = recalcAccess(props.doc);
  const run = useRecalcRun(recalcStore, doc);
  const pageCount = Math.max(1, doc.pages.length);
  const [chosen, setPage] = useState(1);
  const page = Math.min(chosen, pageCount);
  const image = usePageImage(engine, doc, page, access.kind !== "not-a-workbook");
  return (
    <RecalcStageView
      access={access}
      run={run}
      docName={doc.name}
      page={page}
      pageCount={pageCount}
      image={image}
      onRun={() => void recalcStore.run(engine, doc)}
      onPage={setPage}
    />
  );
}

function Rail(props: ModeProps) {
  const access = recalcAccess(props.doc);
  const run = useRecalcRun(recalcStore, props.doc);
  const [sort, setSort] = useState<SortOrder>(DEFAULT_SORT);
  return <RecalcRailView access={access} run={run} sort={sort} onSort={setSort} />;
}

export const mode: LabMode = {
  id: "recalc",
  title: "Recalc",
  summary: "Recalculate a workbook and list each cell whose stored value differs from Wolf's computed value.",
  formats: ["xlsx"],
  kind: "doc",
  Stage,
  Rail,
};
