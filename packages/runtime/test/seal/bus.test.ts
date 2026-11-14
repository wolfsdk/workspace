import { describe, expect, test } from "bun:test";
import type { AssetRef, LabManifest } from "../../src/seal/types.ts";
import {
  type BusEvent,
  MSG_ASSET,
  MSG_ASSET_ERROR,
  type RejectReason,
  checkManifest,
  createAssetClient,
  createAssetServer,
  parseGetRequest,
  parseLoaderMessage,
} from "../../src/seal/bus.ts";

const ORIGIN = "https://lab.test";
const encoder = new TextEncoder();

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A manifest whose ids are real digests of the bytes, plus the bytes. */
async function fixture() {
  const files: Record<string, Uint8Array> = {
    "capabilities.json": encoder.encode('{"schema":"wolf-lab-capabilities.v1"}'),
    "claims.json": encoder.encode("[]"),
    "rival-truth.json": encoder.encode('{"schema":"wolf-lab-rival-truth.v1"}'),
    "engine/wolf_web.wasm": new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  };
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const refs: Record<string, AssetRef> = {};
  for (const [path, data] of Object.entries(files)) {
    const id = await sha256Hex(data.slice().buffer);
    bytes.set(id, new Uint8Array(data));
    refs[path] = { id, path, bytes: data.byteLength, type: "application/octet-stream" };
  }
  const manifest: LabManifest = {
    schema: "wolf-lab-manifest.v1",
    build: "test",
    engine: null,
    scenarios: [],
    capabilities: refs["capabilities.json"]!,
    claims: refs["claims.json"]!,
    rivalTruth: refs["rival-truth.json"]!,
    assets: Object.values(refs),
  };
  return { manifest, bytes, refs };
}

async function server(overrides: { load?: (ref: AssetRef) => Promise<ArrayBuffer> } = {}) {
  const { manifest, bytes, refs } = await fixture();
  const vault = { name: "vault window" };
  const rejected: RejectReason[] = [];
  const loads: string[] = [];
  const srv = createAssetServer({
    manifest,
    origin: ORIGIN,
    vault: () => vault,
    load:
      overrides.load ??
      (async (ref) => {
        loads.push(ref.id);
        return bytes.get(ref.id)!.slice().buffer;
      }),
    digest: sha256Hex,
    onReject: (reason) => rejected.push(reason),
  });
  const ev = (data: unknown, extra: Partial<BusEvent> = {}): BusEvent => ({ data, origin: ORIGIN, source: vault, ...extra });
  return { srv, ev, vault, rejected, loads, refs, manifest, bytes };
}

describe("parseGetRequest", () => {
  const id = "a".repeat(64);
  test("accepts exactly { type: 'get', id }", () => {
    expect(parseGetRequest({ type: "get", id })).toBe(id);
  });
  test.each([
    ["null", null],
    ["a string", `get ${id}`],
    ["an array", ["get", id]],
    ["a missing id", { type: "get" }],
    ["another type", { type: "put", id }],
    ["an extra key", { type: "get", id, path: "engine/wolf_web.wasm" }],
    ["uppercase hex", { type: "get", id: "A".repeat(64) }],
    ["a short id", { type: "get", id: "a".repeat(63) }],
    ["a path instead of an id", { type: "get", id: "../manifest.json" }],
    ["a non-string id", { type: "get", id: 42 }],
    ["a class instance", Object.assign(Object.create({ inherited: true }), { type: "get", id })],
  ])("rejects %s", (_label, data) => {
    expect(parseGetRequest(data)).toBeNull();
  });
});

describe("asset server allowlist", () => {
  test("answers a listed id with its bytes, transferred", async () => {
    const { srv, ev, refs, bytes } = await server();
    const ref = refs["claims.json"]!;
    const answer = await srv.handle(ev({ type: "get", id: ref.id }));
    const message = answer?.message;
    if (message?.type !== MSG_ASSET) throw new Error(`expected an asset reply, got `);
    expect(message.id).toBe(ref.id);
    expect(message.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(message.bytes)).toEqual(bytes.get(ref.id)!);
    expect(answer!.transfer).toEqual([message.bytes]);
  });

  test("drops an unknown id without loading anything", async () => {
    const { srv, ev, rejected, loads } = await server();
    expect(await srv.handle(ev({ type: "get", id: "b".repeat(64) }))).toBeNull();
    expect(rejected).toEqual(["unlisted"]);
    expect(loads).toEqual([]);
  });

  test("drops a wrong shape", async () => {
    const { srv, ev, rejected, refs } = await server();
    const id = refs["claims.json"]!.id;
    for (const data of [{ type: "get", id, extra: 1 }, { type: "GET", id }, { id }, id, null, undefined, 7]) {
      expect(await srv.handle(ev(data))).toBeNull();
    }
    expect(rejected).toEqual(["shape", "shape", "shape", "shape", "shape", "shape", "shape"]);
  });

  test("drops a message from another window", async () => {
    const { srv, ev, rejected, refs, loads } = await server();
    const id = refs["claims.json"]!.id;
    expect(await srv.handle(ev({ type: "get", id }, { source: { name: "some other window" } }))).toBeNull();
    expect(await srv.handle(ev({ type: "get", id }, { source: null }))).toBeNull();
    expect(rejected).toEqual(["source", "source"]);
    expect(loads).toEqual([]);
  });

  test("drops a message from another origin, even from the vault window", async () => {
    const { srv, ev, rejected, refs } = await server();
    const id = refs["claims.json"]!.id;
    for (const origin of ["https://evil.test", "null", "http://lab.test", `${ORIGIN}:443`]) {
      expect(await srv.handle(ev({ type: "get", id }, { origin }))).toBeNull();
    }
    expect(rejected).toEqual(["origin", "origin", "origin", "origin"]);
  });

  test("refuses to pass on bytes that do not match their id", async () => {
    const { srv, ev, refs } = await server({ load: async (ref) => new Uint8Array(ref.bytes).buffer });
    const answer = await srv.handle(ev({ type: "get", id: refs["claims.json"]!.id }));
    expect(answer!.message).toMatchObject({ type: MSG_ASSET_ERROR, error: expect.stringContaining("sha256 differs") });
    expect(answer!.transfer).toEqual([]);
  });

  test("reports a failed load for a listed id", async () => {
    const { srv, ev, refs } = await server({
      load: async () => {
        throw new Error("answered 404");
      },
    });
    const answer = await srv.handle(ev({ type: "get", id: refs["claims.json"]!.id }));
    expect(answer!.message).toEqual({
      type: MSG_ASSET_ERROR,
      id: refs["claims.json"]!.id,
      error: "claims.json: answered 404",
    });
  });
});

describe("vault client over the bus", () => {
  async function connected() {
    const s = await server();
    const sent: unknown[] = [];
    const client = createAssetClient(s.manifest, (request) => {
      sent.push(request);
      void s.srv.handle(s.ev(request)).then((answer) => answer && client.receive(answer.message));
    });
    return { ...s, client, sent };
  }

  test("gets bytes by ref and by id, and resolves paths", async () => {
    const { client, refs, bytes } = await connected();
    const ref = client.resolve("engine/wolf_web.wasm")!;
    expect(ref).toEqual(refs["engine/wolf_web.wasm"]!);
    expect(await client.get(ref)).toEqual(bytes.get(ref.id)!);
    expect(await client.get(ref.id)).toEqual(bytes.get(ref.id)!);
    expect(client.resolve("not/listed")).toBeUndefined();
  });

  test("refuses unlisted ids before sending anything", async () => {
    const { client, sent } = await connected();
    expect(client.get("c".repeat(64))).rejects.toThrow("asset not in manifest");
    expect(sent).toEqual([]);
  });

  test("shares one request per id and hands out separate copies", async () => {
    const { client, sent, refs } = await connected();
    const ref = refs["claims.json"]!;
    const [a, b] = await Promise.all([client.get(ref), client.get(ref)]);
    expect(sent).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.buffer).not.toBe(b.buffer);
    structuredClone(a.buffer, { transfer: [a.buffer] });
    expect((await client.get(ref)).byteLength).toBe(ref.bytes);
    expect(sent).toHaveLength(1);
  });

  test("rejects when the loader reports an error", async () => {
    const { manifest, refs } = await server();
    const ref = refs["claims.json"]!;
    const client = createAssetClient(manifest, (request) =>
      queueMicrotask(() => client.receive({ type: MSG_ASSET_ERROR, id: request.id, error: "claims.json: answered 500" })),
    );
    expect(client.get(ref)).rejects.toThrow("answered 500");
  });

  test("parseLoaderMessage accepts only the three loader messages", () => {
    const id = "d".repeat(64);
    expect(parseLoaderMessage({ type: MSG_ASSET, id, bytes: new ArrayBuffer(1) })).not.toBeNull();
    expect(parseLoaderMessage({ type: MSG_ASSET_ERROR, id, error: "x" })).not.toBeNull();
    const names = new Set(["content-security-policy", "referrer-policy"]);
    const csp = { "content-security-policy": "default-src 'none'" };
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: csp }, names)).not.toBeNull();
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: {} })).not.toBeNull();
    // Exactly three keys, header names from the policy, string values.
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {} }, names)).toBeNull();
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: csp, extra: 1 }, names)).toBeNull();
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: csp })).toBeNull();
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: { "x-other": "1" } }, names)).toBeNull();
    expect(
      parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: { "content-security-policy": 1 } }, names),
    ).toBeNull();
    expect(parseLoaderMessage({ type: "wolf-lab-manifest", manifest: {}, policyHeaders: [] }, names)).toBeNull();
    expect(parseLoaderMessage({ type: MSG_ASSET, id, bytes: new Uint8Array(1) })).toBeNull();
    expect(parseLoaderMessage({ type: MSG_ASSET, id: "nope", bytes: new ArrayBuffer(1) })).toBeNull();
    expect(parseLoaderMessage({ type: "get", id })).toBeNull();
  });
});

describe("checkManifest", () => {
  test("accepts a manifest once every scenario ref is in the asset list", async () => {
    const { manifest } = await fixture();
    const ref = (path: string, digit: string): AssetRef => ({
      id: digit.repeat(64),
      path,
      bytes: 1,
      type: "application/octet-stream",
    });
    const scenario = {
      id: "contract-redline",
      title: "Contract redline",
      file: ref("scenarios/contract-redline/input.docx", "a"),
      tape: ref("scenarios/contract-redline/tape.json", "b"),
    };
    const unlisted: LabManifest = { ...manifest, scenarios: [scenario] };
    expect(() => checkManifest(unlisted)).toThrow("scenario contract-redline file is not in the asset list");
    const fixed: LabManifest = { ...unlisted, assets: [...manifest.assets, scenario.file, scenario.tape] };
    expect(checkManifest(fixed)).toBe(fixed);
  });

  test("rejects a wrong schema and malformed assets", () => {
    expect(() => checkManifest({ schema: "wolf-lab-manifest.v0" })).toThrow("wrong schema");
    expect(() => checkManifest({ schema: "wolf-lab-manifest.v1", assets: [{ id: "x" }], scenarios: [] })).toThrow(
      "malformed",
    );
  });
});
