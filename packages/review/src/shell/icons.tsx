import type { DocFormat } from "@wolfsdk/protocol";

/** 16 px stroke icons drawn on a 24-unit grid; colour follows `currentColor`. */
const PATHS = {
  open: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1M3 7v11a1 1 0 0 0 1 1h14.5a1 1 0 0 0 1-.8L21.5 11a1 1 0 0 0-1-1.2H7a1 1 0 0 0-1 .8L3.5 19",
  save: "M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2zM8 3v5h7V3M7 21v-7h10v7",
  saveAs: "M12 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10l4 4v4M8 3v5h7V3M7 21v-7h5M18.5 13.5l2 2L15 21h-2v-2z",
  close: "M6 6l12 12M18 6L6 18",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  fitWidth: "M3 5v14M21 5v14M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3",
  fitPage: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM9 8h6M9 12h6M9 16h4",
  panelLeft: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16",
  panelRight: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM15 4v16",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  chevronDown: "M6 9l6 6 6-6",
  keyboard:
    "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  gauge: "M12 14l4-4M3.5 17a9 9 0 1 1 17 0M12 5v1M5.6 8.6l.7.7M18.4 8.6l-.7.7",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M5 12l5 5 9-10",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  refresh: "M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4",
  // Side panel tabs
  tree: "M4 4h6v5H4zM14 15h6v5h-6zM14 4h6v5h-6zM7 9v8.5h7M10 6.5h4",
  comment: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 10h8M8 13h5",
  track: "M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM14.5 7.5l2 2M13 20h7",
  diff: "M7 3v12M3 7h8M13 17h8M17 9l4 4-4 4M7 21v-2",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  note: "M5 3h10l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 11h8M8 15h8M8 7h4",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      class="we-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={name === "more" ? 3 : 1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

const FORMAT_COLOR: Record<DocFormat, string> = { docx: "#2b5fc4", pptx: "#c4532b", xlsx: "#1f7a4a" };
const FORMAT_LETTER: Record<DocFormat, string> = { docx: "W", pptx: "P", xlsx: "X" };

/** A document sheet with a folded corner and the format's letter tab. */
export function FormatIcon({ format, size = 20 }: { format: DocFormat; size?: number }) {
  const color = FORMAT_COLOR[format];
  return (
    <svg class="we-format-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M7 2h8l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill="var(--we-bg)"
        stroke={color}
        stroke-width="1.5"
      />
      <path d="M15 2v5h5" fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" />
      <rect x="2" y="11" width="12" height="9" rx="2" fill={color} />
      <text
        x="8"
        y="18"
        text-anchor="middle"
        font-size="7.5"
        font-weight="700"
        fill="#ffffff"
        font-family="system-ui, sans-serif"
      >
        {FORMAT_LETTER[format]}
      </text>
    </svg>
  );
}

/** The product mark in the title bar. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg class="we-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="var(--we-accent)" />
      <path
        d="M6 8l2.5 9L12 10l3.5 7L18 8"
        fill="none"
        stroke="var(--we-on-accent)"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
