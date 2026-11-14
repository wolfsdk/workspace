/**
 * Engine selection for `<wolf-review>`.
 *
 * The element runs one engine module, chosen by its `engine` property or, when
 * that is unset, by five attributes that map one to one onto `WolfEngineSource`:
 *
 * | attribute        | `WolfEngineSource` member |
 * |------------------|---------------------------|
 * | `engine-src`     | `url` (resolved against the document base URL) |
 * | `engine-channel` | `channel` (default `https://wolfsdk.com/download/wolf`) |
 * | `engine-version` | `version` (default: the channel's `latest.txt`) |
 * | `engine-sha256`  | `sha256` (default: the channel's `SHA256SUMS` line) |
 * | `engine-format`  | `format`: `docx`, `xlsx`, `pptx`, `pdf` or `auto` |
 *
 * `format` picks the release's split module `wolf_web_<format>.wasm` (or
 * `wolf_web.wasm` when the release has none). `auto` picks it per document: from
 * the `src` file name at start, else once a document is opened (its bytes, then
 * its name), switching modules when the next document needs another one. An
 * exact `url` ignores `format`.
 *
 * The module is fetched, verified and compiled once per source on the page
 * (`../shell/engine.ts`) and handed to each element's kernel worker, so
 * `wolf-ready` fires as soon as it is usable instead of on the first `open`.
 */
import { ENGINE_FORMATS, inferEngineFormat, type EngineFormat, type EngineSource } from "@wolfsdk/runtime/loader";
import { engineKey, engineModule, normalizeSource } from "../shell/engine.ts";
import type { WolfEngineFormat, WolfEngineSource } from "./types.ts";

export { engineKey, engineLoad, engineModule } from "../shell/engine.ts";

/** The attributes that choose the engine; a change to any of them restarts it. */
export const ENGINE_ATTRIBUTES = [
  "engine-src",
  "engine-channel",
  "engine-version",
  "engine-sha256",
  "engine-format",
] as const;

export type EngineAttribute = (typeof ENGINE_ATTRIBUTES)[number];

/** `value` as an engine format (`auto` included), case-insensitive; undefined for anything else. */
export function engineFormatOf(value: string | null | undefined): WolfEngineFormat | undefined {
  const format = value?.trim().toLowerCase();
  return format === "auto" || ENGINE_FORMATS.includes(format as EngineFormat) ? (format as WolfEngineFormat) : undefined;
}

/**
 * The engine source of an element: `property` when set (the `engine` property
 * wins over the attributes as a whole), otherwise the five attributes read
 * through `attribute`. Empty attributes count as absent. The result is in
 * canonical form (see `normalizeSource`; `format` only without `url`), so equal
 * sources compare equal.
 */
export function engineSourceOf(
  attribute: (name: EngineAttribute) => string | null,
  property: WolfEngineSource | null,
): WolfEngineSource {
  let source: WolfEngineSource;
  if (property) source = property;
  else {
    source = {};
    const url = attribute("engine-src");
    const channel = attribute("engine-channel");
    const version = attribute("engine-version");
    const sha256 = attribute("engine-sha256");
    if (url) source.url = url;
    if (channel) source.channel = channel;
    if (version) source.version = version;
    if (sha256) source.sha256 = sha256;
    source.format = engineFormatOf(attribute("engine-format"));
  }
  const { format, ...rest } = source;
  const normalized: WolfEngineSource = normalizeSource(rest);
  const known = engineFormatOf(format);
  if (known && normalized.url === undefined) normalized.format = known;
  return normalized;
}

/** True when `a` and `b` load the same module (the element then keeps its engine). */
export function sameEngine(a: WolfEngineSource, b: WolfEngineSource): boolean {
  const key = ({ format, ...rest }: WolfEngineSource) =>
    format === "auto" ? `${engineKey(rest)}${rest.url === undefined ? "#auto" : ""}` : engineKey({ ...rest, format });
  return key(a) === key(b);
}

/** The module source of `config` for documents of `format` (the release's monolith without one). */
export function engineSourceFor(config: WolfEngineSource, format?: EngineFormat): EngineSource {
  const { format: _configured, ...rest } = config;
  return normalizeSource(format ? { ...rest, format } : rest);
}

/**
 * The module an element loads when it starts: `config`'s own format (none: the
 * monolith); for `auto`, the format of the `src` file name (`name` first), or
 * null to wait for a document when there is no `src` or its name tells no format.
 */
export function initialEngineSource(
  config: WolfEngineSource,
  src: string | null,
  name: string | null,
): EngineSource | null {
  if (config.format !== "auto") return engineSourceFor(config, config.format);
  const format = src ? inferEngineFormat({ name, url: src }) : undefined;
  return format ? engineSourceFor(config, format) : null;
}

/**
 * The module to switch to before opening `bytes` (`name`), or null to open it in
 * the running one: only `auto` switches, to the module of the document's format
 * (bytes, then name). Without a running module (`current` null) the result is
 * that module, or the monolith for a format nobody can tell. A target that
 * resolves to the running module's URL (a release without split modules) keeps
 * it. The target's module starts loading here, so a switch reuses it.
 */
export async function engineForDocument(
  config: WolfEngineSource,
  current: EngineSource | null,
  bytes: Uint8Array,
  name: string,
): Promise<EngineSource | null> {
  if (config.format !== "auto") return null;
  const format = inferEngineFormat({ name, bytes });
  if (!current) return engineSourceFor(config, format);
  if (!format) return null;
  const target = engineSourceFor(config, format);
  if (engineKey(target) === engineKey(current)) return null;
  try {
    const [running, next] = await Promise.all([engineModule(current), engineModule(target)]);
    return running.resolved.url === next.resolved.url ? null : target;
  } catch {
    // The new session shows the failure (and Retry).
    return target;
  }
}
