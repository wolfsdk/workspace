/**
 * Every seal kit send goes through `post`, which keeps the native
 * `postMessage` out of tail position. Bun runs JavaScriptCore, which has
 * proper tail calls in strict code like WebKit, so a stack captured inside a
 * fake `postMessage` shows whether the calling frame survived: with a tail
 * call from a timer or a promise job it does not, and that is the case in
 * which WebKit reports the receiving window as `event.source`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { AssetRef, LabManifest } from "../../src/seal/types.ts";
import { MSG_MANIFEST } from "../../src/seal/bus.ts";
import { startLoader } from "../../src/seal/loader.ts";
import { post } from "../../src/seal/post.ts";
import { createVaultAssets } from "../../src/seal/vault.ts";

const ORIGIN = "https://lab.test";
const encoder = new TextEncoder();
const scope = globalThis as unknown as Record<string, unknown>;
const saved = { window: scope.window, document: scope.document, fetch: scope.fetch };

afterEach(() => {
  scope.window = saved.window;
  scope.document = saved.document;
  scope.fetch = saved.fetch;
});

type Sent = { message: unknown; options: unknown; caller: string };

/** A window-like target that records each message and the frame that called its postMessage. */
function target(name: string) {
  const sent: Sent[] = [];
  const waiters: (() => void)[] = [];
  return {
    name,
    sent,
    /** Resolves once `count` messages have arrived. */
    received(count: number): Promise<void> {
      return new Promise((resolve) => {
        const check = () => (sent.length >= count ? resolve() : waiters.push(check));
        check();
      });
    },
    postMessage(message: unknown, options?: unknown) {
      const frames = (new Error().stack ?? "").split("\n").filter((line) => line.trim().startsWith("at "));
      // frames[0] is this postMessage; frames[1] is whoever called it.
      const caller = /at (?:async )?([^\s(]+)/.exec(frames[1] ?? "")?.[1] ?? "<none>";
      sent.push({ message, options, caller });
      for (const wake of waiters.splice(0)) wake();
    },
  };
}

// A real zero-delay timer on purpose: the defect needs the call entered from a
// timer task with no script frame beneath it, which fake timers do not give.
// Each use awaits the callback's own result, not a guessed duration.
const later = <T>(fn: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(fn()), 0));

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fixture() {
  const files: Record<string, string> = {
    "capabilities.json": '{"schema":"wolf-lab-capabilities.v1"}',
    "claims.json": "[]",
    "rival-truth.json": '{"schema":"wolf-lab-rival-truth.v1"}',
  };
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const refs: Record<string, AssetRef> = {};
  for (const [path, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const id = await sha256Hex(data.slice().buffer);
    bytes.set(id, data);
    refs[path] = { id, path, bytes: data.byteLength, type: "application/json" };
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

describe("post", () => {
  test("this runtime drops a tail-calling frame, so the checks below mean something", async () => {
    const fake = target("receiver");
    const direct = () => fake.postMessage("m", {});
    await later(direct);
    await Promise.resolve().then(direct);
    // No caller frame left: the case in which WebKit names the receiver as the source.
    expect(fake.sent.map((s) => s.caller)).not.toContain("direct");
  });

  test("the native is called from post's own frame, whatever called post", async () => {
    const fake = target("receiver");
    const tail = () => post(fake, "m", { targetOrigin: ORIGIN });
    await later(tail);
    await Promise.resolve().then(tail);
    tail();
    expect(fake.sent.map((s) => s.caller)).toEqual(["post", "post", "post"]);
    expect(fake.sent[0]!.options).toEqual({ targetOrigin: ORIGIN });
  });

  test("no other seal kit source calls postMessage", () => {
    const dir = new URL("../../src/seal/", import.meta.url);
    const calls: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const lines = readFileSync(new URL(name, dir), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const code = line.replace(/\/\/.*$/, "").trim();
        if (code.startsWith("*") || code.startsWith("/*")) continue;
        if (/\.postMessage\s*\(/.test(code)) calls.push(`${name}:${index + 1}: ${code}`);
      }
    }
    expect(calls).toEqual([expect.stringMatching(/^post\.ts:\d+: target\.postMessage\(message, options\);$/)]);
  });
});

describe("send paths", () => {
  test("vault requests go through post, and the vault still drops messages from its own window", async () => {
    const { manifest, refs } = await fixture();
    const parent = target("loader window");
    const listeners: ((event: unknown) => void)[] = [];
    const vaultWindow = {
      parent,
      location: { origin: ORIGIN },
      addEventListener: (_type: string, fn: (event: unknown) => void) => listeners.push(fn),
    };
    scope.window = vaultWindow;
    const assets = createVaultAssets();
    const announce = { type: MSG_MANIFEST, manifest, policyHeaders: {} };

    // What WebKit did before the fix: the receiver named as the source. Dropped.
    listeners[0]!({ data: announce, origin: ORIGIN, source: vaultWindow });
    const early = await Promise.race([assets.then(() => "resolved"), later(() => "pending")]);
    expect(early).toBe("pending");

    await later(() => listeners[0]!({ data: announce, origin: ORIGIN, source: parent }));
    const client = await assets;
    void later(() => client.get(refs["claims.json"]!));
    await parent.received(1);
    expect(parent.sent[0]).toEqual({
      message: { type: "get", id: refs["claims.json"]!.id },
      options: { targetOrigin: ORIGIN },
      caller: "post",
    });
  });

  test("the loader's announcement and asset replies go through post", async () => {
    const { manifest, bytes, refs } = await fixture();
    const vault = target("vault window");
    const messageListeners: ((event: unknown) => void)[] = [];
    const loadListeners: (() => void)[] = [];
    scope.window = {
      location: { origin: ORIGIN },
      addEventListener: (_type: string, fn: (event: unknown) => void) => messageListeners.push(fn),
    };
    scope.document = { baseURI: `${ORIGIN}/lab/` };
    scope.fetch = async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/lab/manifest.json") return new Response(JSON.stringify(manifest));
      if (url.pathname === "/lab/vault/") {
        return new Response("<!doctype html>", { headers: { "Content-Security-Policy": "default-src 'none'" } });
      }
      const id = url.pathname.slice("/lab/cas/".length);
      const body = bytes.get(id);
      return body ? new Response(body.slice()) : new Response("missing", { status: 404 });
    };
    const frame = {
      src: `${ORIGIN}/lab/vault/`,
      contentWindow: vault,
      contentDocument: null,
      addEventListener: (_type: string, fn: () => void) => loadListeners.push(fn),
    };
    await startLoader({ frame: frame as unknown as HTMLIFrameElement, manifestUrl: "manifest.json" });

    // The frame's load event, fired with no script frame beneath it.
    await later(() => loadListeners[0]!());
    await vault.received(1);
    expect(vault.sent[0]!.caller).toBe("post");
    expect(vault.sent[0]!.options).toEqual({ targetOrigin: ORIGIN });
    expect(vault.sent[0]!.message).toEqual({
      type: MSG_MANIFEST,
      manifest,
      policyHeaders: { "content-security-policy": "default-src 'none'" },
    });

    const id = refs["claims.json"]!.id;
    await later(() => messageListeners[0]!({ data: { type: "get", id }, origin: ORIGIN, source: vault }));
    await vault.received(2);
    expect(vault.sent[1]!.caller).toBe("post");
    expect(vault.sent[1]!.message).toMatchObject({ type: "wolf-lab-asset", id });
    expect((vault.sent[1]!.options as { targetOrigin: string }).targetOrigin).toBe(ORIGIN);
  });
});
