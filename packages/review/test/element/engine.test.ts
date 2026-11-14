import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_ENGINE_CHANNEL, EngineLoadError } from "@wolfsdk/runtime/loader";
import { ENGINE_ATTRIBUTES, engineSourceOf, sameEngine } from "../../src/element/engine.ts";
import {
  engineError,
  engineKey,
  engineLoad,
  engineModule,
  normalizeSource,
  workerSource,
} from "../../src/shell/engine.ts";

/** The smallest valid WebAssembly module: magic and version, no sections. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const EMPTY_SHA = createHash("sha256").update(EMPTY_MODULE).digest("hex");

/** A `fetch` that serves `files` by absolute URL (404 otherwise) and records every request. */
function serve(files: Record<string, string | Uint8Array>): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fake = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
    const headers: Record<string, string> = {};
    if (body instanceof Uint8Array) headers["content-length"] = String(body.byteLength);
    return new Response(body as BodyInit, { status: 200, headers });
  };
  return { fetch: fake as typeof fetch, requests };
}

/** A fresh channel root per test, so the per-page module cache never answers for another test. */
let channels = 0;
function channel(): string {
  channels++;
  return `https://engine.test/c${channels}`;
}

describe("engine attributes", () => {
  const attrs = (values: Record<string, string>) => (name: string) => values[name] ?? null;

  test("the five attributes map onto WolfEngineSource", () => {
    expect([...ENGINE_ATTRIBUTES]).toEqual(["engine-src", "engine-channel", "engine-version", "engine-sha256", "engine-format"]);
    expect(
      engineSourceOf(
        attrs({ "engine-channel": "https://cdn.test/wolf/", "engine-version": " 1.2.3 ", "engine-sha256": "AB".repeat(32) }),
        null,
      ),
    ).toEqual({ channel: "https://cdn.test/wolf", version: "1.2.3", sha256: "ab".repeat(32) });
  });

  test("no attribute means the default channel at its latest version", () => {
    expect(engineSourceOf(attrs({}), null)).toEqual({ channel: DEFAULT_ENGINE_CHANNEL });
    expect(engineSourceOf(attrs({ "engine-src": "", "engine-version": "" }), null)).toEqual({
      channel: DEFAULT_ENGINE_CHANNEL,
    });
  });

  test("engine-src wins over channel and version", () => {
    expect(
      engineSourceOf(
        attrs({ "engine-src": "https://cdn.test/wolf_web.wasm", "engine-channel": "https://x.test", "engine-version": "1.0.0" }),
        null,
      ),
    ).toEqual({ url: "https://cdn.test/wolf_web.wasm" });
  });

  test("the property wins over the attributes as a whole", () => {
    const fetcher = (async () => new Response("")) as unknown as typeof fetch;
    expect(engineSourceOf(attrs({ "engine-version": "1.0.0" }), { channel: "https://p.test/", fetch: fetcher })).toEqual({
      channel: "https://p.test",
      fetch: fetcher,
    });
  });

  test("sources that load the same module compare equal", () => {
    expect(sameEngine({}, { channel: `${DEFAULT_ENGINE_CHANNEL}/` })).toBe(true);
    expect(sameEngine({ version: "1.0.0" }, { version: "1.0.1" })).toBe(false);
    expect(sameEngine({ url: "https://a.test/m.wasm", version: "1.0.0" }, { url: "https://a.test/m.wasm" })).toBe(true);
    expect(sameEngine({ sha256: "AA".repeat(32) }, { sha256: "aa".repeat(32) })).toBe(true);
    const one = (async () => new Response("")) as unknown as typeof fetch;
    const two = (async () => new Response("")) as unknown as typeof fetch;
    expect(engineKey({ fetch: one })).toBe(engineKey({ fetch: one }));
    expect(engineKey({ fetch: one })).not.toBe(engineKey({ fetch: two }));
    expect(engineKey({ fetch: one })).not.toBe(engineKey({}));
  });

  test("the worker receives the source without its fetch", () => {
    const fetcher = (async () => new Response("")) as unknown as typeof fetch;
    expect(workerSource({ channel: "https://c.test/", version: "2.0.0", fetch: fetcher })).toEqual({
      channel: "https://c.test",
      version: "2.0.0",
    });
    expect(normalizeSource({ url: "https://c.test/m.wasm", channel: "https://ignored.test" })).toEqual({
      url: "https://c.test/m.wasm",
    });
  });

  test("a format is part of a channel source and of its cache key, and does not apply to an exact URL", () => {
    expect(normalizeSource({ channel: "https://c.test/", version: "2.0.0", format: "xlsx" })).toEqual({
      channel: "https://c.test",
      version: "2.0.0",
      format: "xlsx",
    });
    expect(workerSource({ channel: "https://c.test", format: "pdf" })).toEqual({
      channel: "https://c.test",
      format: "pdf",
    });
    expect(sameEngine({ format: "docx" }, { format: "docx" })).toBe(true);
    expect(sameEngine({ format: "docx" }, { format: "xlsx" })).toBe(false);
    expect(sameEngine({ format: "docx" }, {})).toBe(false);
    expect(normalizeSource({ url: "https://c.test/m.wasm", format: "docx" })).toEqual({ url: "https://c.test/m.wasm" });
    expect(sameEngine({ url: "https://c.test/m.wasm", format: "docx" }, { url: "https://c.test/m.wasm" })).toBe(true);
  });
});

describe("engine errors", () => {
  test("loader failures keep their code and URL", () => {
    const error = engineError(new EngineLoadError("checksum-mismatch", "bad bytes", "https://c.test/m.wasm"), null, true);
    expect(error).toEqual({ code: "checksum-mismatch", message: "bad bytes", argument: "https://c.test/m.wasm" });
  });

  test("other failures are download or compile failures", () => {
    expect(engineError(new Error("reset"), "https://c.test/m.wasm", false)).toEqual({
      code: "module-download-failed",
      message: "reset",
      argument: "https://c.test/m.wasm",
    });
    expect(engineError(new Error("not wasm"), null, true)).toEqual({ code: "wasm-compile-failed", message: "not wasm" });
  });
});

describe("module load", () => {
  test("resolves the channel, verifies and compiles once per source", async () => {
    const root = channel();
    const { fetch, requests } = serve({
      [`${root}/latest.txt`]: "1.2.3\n",
      [`${root}/v1.2.3/SHA256SUMS`]: `${EMPTY_SHA}  wolf_web.wasm\n`,
      [`${root}/v1.2.3/wolf_web.wasm`]: EMPTY_MODULE,
    });
    const source = { channel: root, fetch };
    const load = engineLoad(source);
    const first = await engineModule(source);
    const second = await engineModule({ channel: `${root}/`, fetch });
    expect(first.resolved).toEqual({ url: `${root}/v1.2.3/wolf_web.wasm`, version: "1.2.3", sha256: EMPTY_SHA });
    expect(first.module).toBeInstanceOf(WebAssembly.Module);
    expect(second).toBe(first);
    expect(requests).toEqual([`${root}/latest.txt`, `${root}/v1.2.3/SHA256SUMS`, `${root}/v1.2.3/wolf_web.wasm`]);
    const status = load.getStatus();
    expect(status.stage).toBe("ready");
    expect(status.loaded).toBe(EMPTY_MODULE.byteLength);
    expect(status.total).toBe(EMPTY_MODULE.byteLength);
    expect(status.resolved).toEqual(first.resolved);
    expect(status.error).toBeNull();
  });

  test("a pinned version with its checksum fetches only the module", async () => {
    const root = channel();
    const { fetch, requests } = serve({ [`${root}/v2.0.0/wolf_web.wasm`]: EMPTY_MODULE });
    const { resolved } = await engineModule({ channel: root, version: "2.0.0", sha256: EMPTY_SHA, fetch });
    expect(resolved.version).toBe("2.0.0");
    expect(requests).toEqual([`${root}/v2.0.0/wolf_web.wasm`]);
  });

  test("an exact URL skips the channel", async () => {
    const url = `${channel()}/custom/wolf_web.wasm`;
    const { fetch, requests } = serve({ [url]: EMPTY_MODULE });
    const { resolved } = await engineModule({ url, fetch });
    expect(resolved).toEqual({ url, version: null, sha256: null });
    expect(requests).toEqual([url]);
  });

  test("a checksum mismatch fails the load with the loader's code, and a retry loads again", async () => {
    const root = channel();
    const files: Record<string, string | Uint8Array> = {
      [`${root}/latest.txt`]: "1.0.0",
      [`${root}/v1.0.0/SHA256SUMS`]: `${"0".repeat(64)}  wolf_web.wasm\n`,
      [`${root}/v1.0.0/wolf_web.wasm`]: EMPTY_MODULE,
    };
    const { fetch } = serve(files);
    const source = { channel: root, fetch };
    const load = engineLoad(source);
    await expect(engineModule(source)).rejects.toBeInstanceOf(EngineLoadError);
    await load.downloaded();
    expect(load.getStatus().stage).toBe("failed");
    expect(load.getStatus().error).toMatchObject({ code: "checksum-mismatch", argument: `${root}/v1.0.0/wolf_web.wasm` });
    // Failed loads are not cached: fixing the channel and asking again succeeds.
    files[`${root}/v1.0.0/SHA256SUMS`] = `${EMPTY_SHA}  wolf_web.wasm\n`;
    const { resolved } = await engineModule(source);
    expect(resolved.sha256).toBe(EMPTY_SHA);
  });

  test("an unreachable channel and bytes that do not compile keep distinct codes", async () => {
    const root = channel();
    const { fetch } = serve({});
    const unreachable = { channel: root, fetch };
    const load = engineLoad(unreachable);
    await expect(engineModule(unreachable)).rejects.toThrow();
    await load.downloaded();
    expect(load.getStatus().error?.code).toBe("channel-unreachable");

    const url = `${channel()}/broken.wasm`;
    const junk = new TextEncoder().encode("not a module");
    const broken = { url, fetch: serve({ [url]: junk }).fetch };
    const brokenLoad = engineLoad(broken);
    await expect(engineModule(broken)).rejects.toThrow();
    await brokenLoad.downloaded();
    expect(brokenLoad.getStatus().error).toMatchObject({ code: "wasm-compile-failed", argument: url });
  });

  test("a consumer's own failure does not mark the shared load", async () => {
    const url = `${channel()}/wolf_web.wasm`;
    const { fetch } = serve({ [url]: EMPTY_MODULE });
    const a = engineLoad({ url, fetch });
    const b = engineLoad({ url, fetch });
    await engineModule({ url, fetch });
    a.failed({ code: "kernel-closed", message: "worker stopped" });
    expect(a.getStatus()).toMatchObject({ stage: "failed", error: { code: "kernel-closed" } });
    expect(b.getStatus().stage).toBe("ready");
  });

  test("a format loads its own module when the release lists it, else wolf_web.wasm; each source is cached once", async () => {
    const root = channel();
    const { fetch, requests } = serve({
      [`${root}/v1.4.0/SHA256SUMS`]: `${"1".repeat(64)}  wolf_web.wasm\n${EMPTY_SHA}  wolf_web_docx.wasm\n`,
      [`${root}/v1.4.0/wolf_web_docx.wasm`]: EMPTY_MODULE,
      [`${root}/v1.4.0/wolf_web.wasm`]: EMPTY_MODULE,
    });
    const docx = { channel: root, version: "1.4.0", format: "docx" as const, fetch };
    const first = await engineModule(docx);
    expect(first.resolved).toEqual({ url: `${root}/v1.4.0/wolf_web_docx.wasm`, version: "1.4.0", sha256: EMPTY_SHA });
    expect(await engineModule({ ...docx })).toBe(first);
    expect(requests).toEqual([`${root}/v1.4.0/SHA256SUMS`, `${root}/v1.4.0/wolf_web_docx.wasm`]);

    // No wolf_web_pdf.wasm in this release: the load falls back to wolf_web.wasm and checks it against
    // that module's own line (wrong on purpose here, so the failure names the module that was chosen).
    const pdf = { ...docx, format: "pdf" as const };
    const load = engineLoad(pdf);
    await expect(engineModule(pdf)).rejects.toThrow();
    await load.downloaded();
    expect(load.getStatus().error).toMatchObject({
      code: "checksum-mismatch",
      argument: `${root}/v1.4.0/wolf_web.wasm`,
    });
  });

  test("a release without per-format modules serves every format from wolf_web.wasm", async () => {
    const root = channel();
    const { fetch } = serve({
      [`${root}/v1.4.0/SHA256SUMS`]: `${EMPTY_SHA}  wolf_web.wasm\n`,
      [`${root}/v1.4.0/wolf_web.wasm`]: EMPTY_MODULE,
    });
    const { resolved } = await engineModule({ channel: root, version: "1.4.0", format: "xlsx", fetch });
    expect(resolved).toEqual({ url: `${root}/v1.4.0/wolf_web.wasm`, version: "1.4.0", sha256: EMPTY_SHA });
  });
});
