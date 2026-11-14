/** @jsxImportSource preact */
import { MEMBER_VERDICTS, type LegendProps } from "../lab/index.ts";
import { VERDICT_TEXT } from "./verdicts.ts";
import "./anatomy.css";

export function Legend({ verdicts = MEMBER_VERDICTS }: LegendProps) {
  return (
    <ul class="wl" aria-label="What each verdict means">
      {verdicts.map((v) => (
        <li key={v} class="wl-item">
          <span class="wl-swatch" data-verdict={v} aria-hidden="true" />
          <span class="wl-text">
            <strong class="wl-label">{VERDICT_TEXT[v].label}</strong> <span class="wl-definition">{VERDICT_TEXT[v].definition}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
