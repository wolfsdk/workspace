/**
 * `@wolfsdk/review/react`: `<WolfReview>`, a React component around `<wolf-review>`.
 *
 * Works with React 18 and 19. Props map onto the element's attributes (set as
 * attributes, so both React versions pass them the same way), `on*` props
 * listen to the element's events, and the ref is the element itself, so its
 * methods (`open`, `openReview`, `save`, `submitReview`, ...) are one call away:
 *
 * ```tsx
 * const ref = useRef<WolfReviewElement>(null);
 * <WolfReview ref={ref} engineVersion="1.4.0" onReviewSubmit={(e) => upload(e.detail)} />
 * ```
 *
 * Importing this module registers `<wolf-review>` (as `@wolfsdk/review/auto`).
 */
import {
  createElement,
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type ReactElement,
} from "react";
import {
  defineWolfReview,
  type WolfEngineFormat,
  type WolfEngineSource,
  type WolfMode,
  type WolfPluginId,
  type WolfReviewElement,
  type WolfReviewEventMap,
} from "./index.ts";

defineWolfReview();

/** The `on*` props and the element events they listen to. */
const EVENTS = {
  onReady: "wolf-ready",
  onOpen: "wolf-open",
  onChange: "wolf-change",
  onSave: "wolf-save",
  onError: "wolf-error",
  onSelection: "wolf-selection",
  onReviewSubmit: "wolf-review-submit",
  onAgentActivity: "wolf-review-agent-activity",
} as const satisfies Record<string, keyof WolfReviewEventMap>;

type EventProp = keyof typeof EVENTS;

export type WolfReviewEventProps = {
  [P in EventProp]?: (event: WolfReviewEventMap[(typeof EVENTS)[P]]) => void;
};

export type WolfReviewProps = WolfReviewEventProps & {
  /**
   * The engine as one `WolfEngineSource`. Wins over `engineSrc`, `engineChannel`, `engineVersion`,
   * `engineSha256` and `engineFormat`. A source with a custom `fetch` is handed to the element's
   * `engine` property after mount, so the element restarts its engine once with it.
   */
  engine?: WolfEngineSource;
  /** `engine-src`: exact URL of the engine module. */
  engineSrc?: string;
  /** `engine-channel`: root holding `latest.txt` and `v<VERSION>/`. */
  engineChannel?: string;
  /** `engine-version`: engine version on the channel. */
  engineVersion?: string;
  /** `engine-sha256`: expected lowercase hex SHA-256 of the module. */
  engineSha256?: string;
  /** `engine-format`: per-format split module (`docx`, `xlsx`, `pptx`, `pdf`) or `auto`. */
  engineFormat?: WolfEngineFormat;
  /** `src`: URL of a document to open. */
  src?: string;
  /** `name`: file name for the document from `src`. */
  name?: string;
  clock?: "live" | "pinned";
  readOnly?: boolean;
  /** `plugins`: the plugins of edit mode, as the attribute string or a list. */
  plugins?: string | readonly WolfPluginId[];
  theme?: "light" | "dark" | "auto";
  unloadGuard?: boolean;
  mode?: WolfMode;
  id?: string;
  className?: string;
  style?: CSSProperties;
};

function text(value: string | URL | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : String(value);
}

/** The element's attributes for `props`; absent values are left out, so React removes them. */
function attributesOf(props: WolfReviewProps): Record<string, string | undefined> {
  const { engine } = props;
  const plugins = typeof props.plugins === "string" ? props.plugins : props.plugins?.join(" ");
  return {
    "engine-src": engine ? text(engine.url) : props.engineSrc,
    "engine-channel": engine ? text(engine.channel) : props.engineChannel,
    "engine-version": engine ? text(engine.version) : props.engineVersion,
    "engine-sha256": engine ? text(engine.sha256) : props.engineSha256,
    "engine-format": engine ? text(engine.format) : props.engineFormat,
    src: props.src,
    name: props.name,
    clock: props.clock,
    readonly: props.readOnly ? "" : undefined,
    plugins,
    theme: props.theme,
    "unload-guard": props.unloadGuard ? "" : undefined,
    mode: props.mode,
  };
}

function WolfReviewRender(props: WolfReviewProps, ref: ForwardedRef<WolfReviewElement>): ReactElement {
  const element = useRef<WolfReviewElement | null>(null);
  const handlers = useRef<WolfReviewEventProps>(props);
  handlers.current = props;

  const setRef = useCallback(
    (node: WolfReviewElement | null) => {
      element.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // One listener per event for the element's lifetime; it calls the current prop.
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const off = (Object.keys(EVENTS) as EventProp[]).map((prop) => {
      const type = EVENTS[prop];
      const listener = (event: Event) => {
        const handler = handlers.current[prop] as ((event: Event) => void) | undefined;
        handler?.(event);
      };
      node.addEventListener(type, listener);
      return () => node.removeEventListener(type, listener);
    });
    return () => {
      for (const remove of off) remove();
    };
  }, []);

  // Only a custom `fetch` needs the property; everything else travels as attributes.
  const { engine } = props;
  useLayoutEffect(() => {
    const node = element.current;
    if (node) node.engine = engine?.fetch ? engine : null;
  }, [engine]);

  return createElement("wolf-review", {
    ref: setRef,
    id: props.id,
    className: props.className,
    style: props.style,
    ...attributesOf(props),
  });
}

/** `<wolf-review>` as a React component; the ref is the element. */
export const WolfReview = forwardRef<WolfReviewElement, WolfReviewProps>(WolfReviewRender);

export type { WolfReviewElement };
