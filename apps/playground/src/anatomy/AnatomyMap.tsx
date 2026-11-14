/** @jsxImportSource preact */
import type { AnatomyMapProps } from "../lab/index.ts";
import { useMemo, useRef } from "preact/hooks";
import { layoutTreemap, type Rect, type TreemapCell } from "./layout.ts";
import { ROLE_LABEL } from "./roles.ts";
import { VERDICT_TEXT, advanceMotion, formatBytes, initialMotion } from "./verdicts.ts";
import "./anatomy.css";

/** Layout space; the canvas keeps the same 16:10 aspect ratio in CSS. */
const WIDTH = 160;
const HEIGHT = 100;
/** Cells at least this large (layout units) show their name. */
const LABEL_MIN_W = 18;
const LABEL_MIN_H = 9;

const pct = (n: number) => `${n}%`;

function placeIn(rect: Rect, frame: Rect) {
  return {
    left: pct(frame.w > 0 ? ((rect.x - frame.x) / frame.w) * 100 : 0),
    top: pct(frame.h > 0 ? ((rect.y - frame.y) / frame.h) * 100 : 0),
    width: pct(frame.w > 0 ? (rect.w / frame.w) * 100 : 0),
    height: pct(frame.h > 0 ? (rect.h / frame.h) * 100 : 0),
  };
}

function describe(cell: TreemapCell, highlighted: boolean): string {
  const parts = [cell.name, ROLE_LABEL[cell.role], `${formatBytes(cell.bytes)} compressed`];
  if (cell.verdict) parts.push(VERDICT_TEXT[cell.verdict].label);
  if (highlighted) parts.push("highlighted");
  return parts.join(", ");
}

export function AnatomyMap({ info, delta, highlight, onSelect, label }: AnatomyMapProps) {
  const layout = useMemo(() => layoutTreemap(info, { delta, width: WIDTH, height: HEIGHT }), [info, delta]);
  const motion = useRef(initialMotion);
  motion.current = advanceMotion(motion.current, delta);
  const { shifted, generation } = motion.current;
  const highlighted = new Set(highlight ?? []);
  const frame: Rect = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
  const visible = (c: TreemapCell) => c.w > 0 && c.h > 0;
  const empty = layout.groups.flatMap((g) => g.cells.filter((c) => !visible(c)));

  const cell = (c: TreemapCell, inline: boolean, group: Rect) => {
    const isHighlighted = highlighted.has(c.name);
    const shift = shifted.has(c.name) ? (generation % 2 ? "a" : "b") : undefined;
    const showName = inline || (c.w >= LABEL_MIN_W && c.h >= LABEL_MIN_H);
    const base = c.name.slice(c.name.lastIndexOf("/") + 1) || c.name;
    const attrs = {
      class: inline ? "wa-cell wa-cell--inline" : "wa-cell",
      style: inline ? undefined : placeIn(c, group),
      title: describe(c, isHighlighted),
      "data-member": c.name,
      "data-verdict": c.verdict,
      "data-highlight": isHighlighted ? "true" : undefined,
      "data-shift": shift,
    };
    const content = showName ? (
      <span class="wa-cell-text">
        <span class="wa-cell-name">{base}</span>
        {c.verdict ? <span class="wa-cell-verdict">{VERDICT_TEXT[c.verdict].label}</span> : null}
      </span>
    ) : null;
    return onSelect ? (
      <button key={c.key} type="button" {...attrs} aria-label={describe(c, isHighlighted)} onClick={() => onSelect(c.name)}>
        {content}
      </button>
    ) : (
      <div key={c.key} {...attrs} role="img" aria-label={describe(c, isHighlighted)}>
        {content}
      </div>
    );
  };

  return (
    <div class="wa" role="group" aria-label={label} data-compared={delta ? "true" : "false"}>
      {info.members.length === 0 && !delta?.verdicts.some((v) => v.verdict === "removed") ? (
        <p class="wa-note">This file has no package members to show.</p>
      ) : (
        <div class="wa-canvas">
          {layout.groups.map((g) => {
            const cells = g.cells.filter(visible);
            if (cells.length === 0) return null;
            return (
              <div
                key={g.role}
                class="wa-group"
                role="group"
                aria-label={`${ROLE_LABEL[g.role]}, ${formatBytes(g.bytes)} compressed`}
                data-role={g.role}
                style={placeIn(g, frame)}
              >
                {cells.map((c) => cell(c, false, g))}
                {g.w >= LABEL_MIN_W && g.h >= LABEL_MIN_H ? (
                  <span class="wa-group-label" aria-hidden="true">
                    {ROLE_LABEL[g.role]}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {empty.length > 0 ? (
        <div class="wa-empty" role="group" aria-label="Members with no compressed bytes">
          <span class="wa-empty-title">Members with no compressed bytes</span>
          {empty.map((c) => cell(c, true, frame))}
        </div>
      ) : null}
    </div>
  );
}
