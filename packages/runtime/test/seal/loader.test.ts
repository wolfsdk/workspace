/**
 * `observeVaultHeaders` must leave a finished request: a cancelled body is
 * reported by Chromium as `net::ERR_ABORTED`, which fails a first-visit
 * budget receipt. These fakes record whether the body was read to its end
 * and whether anything cancelled it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { observeVaultHeaders } from "../../src/seal/loader.ts";

const URL_VAULT = "https://lab.test/lab/vault/";
const scope = globalThis as unknown as Record<string, unknown>;
const savedFetch = scope.fetch;

afterEach(() => {
  scope.fetch = savedFetch;
});

/** A response whose body arrives in chunks, and a record of how it was consumed. */
function tracked(status: number, headers: Record<string, string>) {
  const chunks = ["<!doctype html>", "<title>vault</title>", "<div id=app></div>"];
  const seen = { pulled: 0, finished: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[seen.pulled++];
      if (chunk === undefined) {
        seen.finished = true;
        controller.close();
      } else {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  scope.fetch = async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(body, { status, headers });
  };
  return { seen, requests };
}

describe("observeVaultHeaders", () => {
  test("reads the vault page to its end, never cancels it, and keeps only the policy headers", async () => {
    const { seen, requests } = tracked(200, {
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Unrelated": "ignored",
    });
    const observed = await observeVaultHeaders(URL_VAULT);
    expect(seen).toEqual({ pulled: 4, finished: true, cancelled: false });
    expect(requests).toEqual([{ url: URL_VAULT, init: { cache: "no-store", credentials: "same-origin" } }]);
    expect(observed["content-security-policy"]).toBe("default-src 'none'");
    expect(observed["cross-origin-opener-policy"]).toBe("same-origin");
    expect(observed).not.toHaveProperty("x-unrelated");
  });

  test("a page that does not answer 200 is still read to its end, and observes nothing", async () => {
    const { seen } = tracked(404, { "Content-Security-Policy": "default-src 'none'" });
    expect(await observeVaultHeaders(URL_VAULT)).toEqual({});
    expect(seen).toEqual({ pulled: 4, finished: true, cancelled: false });
  });

  test("a fetch that fails observes nothing", async () => {
    scope.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await observeVaultHeaders(URL_VAULT)).toEqual({});
  });
});
