/** @jsxImportSource preact */
import type { ByteRibbonProps } from "../lab/index.ts";
import { useMemo } from "preact/hooks";
import { changedSpans, isChangedSegment, ribbonSegments, type RibbonSegment } from "./layout.ts";
import { VERDICT_TEXT, formatBytes, untouchedLabel } from "./verdicts.ts";
import "./anatomy.css";

function segmentTitle(s: RibbonSegment): string {
  const range = `bytes ${s.start} to ${s.end - 1}`;
  if (s.kind === "structure") return `ZIP structure, ${range}`;
  return s.verdict ? `${s.name}, ${VERDICT_TEXT[s.verdict].label}, ${range}` : `${s.name}, ${range}`;
}

export function ByteRibbon({ info, delta, label }: ByteRibbonProps) {
  const segments = useMemo(() => ribbonSegments(info, delta), [info, delta]);
  const spans = useMemo(() => changedSpans(segments), [segments]);
  const size = info.bytes > 0 ? info.bytes : 1;
  const place = (start: number, end: number) => ({
    left: `${(start / size) * 100}%`,
    width: `${((end - start) / size) * 100}%`,
  });
  const changedBytes = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
  const summary = delta
    ? `${spans.length} changed ${spans.length === 1 ? "span" : "spans"} covering ${formatBytes(changedBytes)}. ${untouchedLabel(delta.untouchedByteShare)}`
    : `${info.members.length} members in byte order. Apply an edit to see which bytes change.`;

  return (
    <figure class="wr" data-compared={delta ? "true" : "false"}>
      <div class="wr-strip" role="img" aria-label={`${label}. ${summary}`}>
        {segments.map((s) => (
          <div
            key={`${s.start}`}
            class={s.kind === "structure" ? "wr-seg wr-seg--structure" : isChangedSegment(s) ? "wr-seg wr-seg--changed" : "wr-seg"}
            style={place(s.start, s.end)}
            title={segmentTitle(s)}
            data-verdict={s.kind === "member" ? s.verdict : undefined}
          />
        ))}
      </div>
      {delta ? (
        <div class="wr-marks" aria-hidden="true">
          {spans.map((s) => (
            <span key={`${s.start}`} class="wr-mark" style={place(s.start, s.end)} title={s.members.join(", ")} />
          ))}
        </div>
      ) : null}
      <figcaption class="wr-caption">
        {delta ? (
          <>
            <span class="wr-share">{untouchedLabel(delta.untouchedByteShare)}</span>{" "}
            <span class="wr-spans">
              {spans.length === 0
                ? "No changed spans."
                : `${spans.length} changed ${spans.length === 1 ? "span" : "spans"}, marked below the strip.`}
            </span>
          </>
        ) : (
          "Apply an edit to see which bytes change."
        )}
      </figcaption>
    </figure>
  );
}
