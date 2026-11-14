import type { LabMode, ModeProps } from "../../lab/index.ts";
import { useEffect, useMemo, useState } from "preact/hooks";
import { assembleParserText, locatedOnPage } from "./model.ts";
import { useFindings, usePageRaster, useXrayState, xrayStore } from "./store.ts";
import { type CopyState, PageView, ParserPaneView, RailView } from "./views.tsx";
import "./xray.css";

function Stage({ engine, doc }: ModeProps) {
  const state = useXrayState(doc);
  const loaded = useFindings(engine, doc);
  const findings = loaded.status === "ready" ? loaded.value : null;
  const pageInfo = doc.pages.find((p) => p.page === state.page) ?? doc.pages[0];
  const pageNumber = pageInfo?.page ?? 1;
  const raster = usePageRaster(engine, doc, pageNumber);
  const parser = useMemo(() => (findings ? assembleParserText(doc.nodes, findings) : null), [doc, findings]);
  const [copy, setCopy] = useState<{ plain: string; state: CopyState } | null>(null);
  useEffect(() => setCopy(null), [doc]);

  const widthPt = raster.status === "ready" ? raster.value.raster.widthPt : (pageInfo?.widthPt ?? 612);
  const heightPt = raster.status === "ready" ? raster.value.raster.heightPt : (pageInfo?.heightPt ?? 792);
  const selected = findings?.find((f) => f.id === state.selectedId) ?? null;

  const onCopy = () => {
    if (!parser) return;
    const plain = parser.plain;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) {
      setCopy({ plain, state: "failed" });
      return;
    }
    clipboard.writeText(plain).then(
      () => setCopy({ plain, state: "copied" }),
      () => setCopy({ plain, state: "failed" }),
    );
  };

  return (
    <div class="xray">
      {pageInfo ? (
        <PageView
          page={pageNumber}
          pageCount={doc.pages.length}
          widthPt={widthPt}
          heightPt={heightPt}
          image={
            raster.status === "ready"
              ? { status: "ready", value: raster.value.url }
              : raster.status === "error"
                ? raster
                : { status: "loading" }
          }
          located={findings ? locatedOnPage(findings, pageNumber) : []}
          selected={selected}
          loupe={state.loupe}
          glide={state.via !== "pointer"}
          onLoupe={(point, via) => xrayStore.moveLoupe(doc, point, via)}
          onPage={(page) => xrayStore.showPage(doc, page)}
        />
      ) : (
        <p class="xray-note">The engine has no rendered page for this file.</p>
      )}
      <ParserPaneView
        parser={parser}
        nodesAvailable={doc.nodes.length > 0}
        selectedId={state.selectedId}
        copy={copy && parser && copy.plain === parser.plain ? copy.state : "idle"}
        onCopy={onCopy}
      />
    </div>
  );
}

function Rail({ engine, doc }: ModeProps) {
  const state = useXrayState(doc);
  const loaded = useFindings(engine, doc);
  return (
    <RailView
      format={doc.format}
      loaded={loaded}
      selectedId={state.selectedId}
      onSelect={(finding) => xrayStore.select(doc, finding)}
    />
  );
}

export const mode: LabMode = {
  id: "xray",
  kind: "doc",
  title: "X-ray",
  summary: "See the text a parser hands your model that the reader never sees on the page.",
  formats: ["docx", "xlsx", "pptx"],
  Stage,
  Rail,
};
