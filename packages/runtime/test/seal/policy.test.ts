import { describe, expect, test } from "bun:test";
import type { HeaderTarget } from "../../src/seal/types.ts";
import {
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  VAULT_CSP,
  cacheControlFor,
  headersFor,
  headersForPath,
  targetForPath,
} from "../../src/seal/policy.ts";

/** Directive name -> sources, parsed back out of a header value. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    expect(out.has(name)).toBe(false); // no directive twice
    out.set(name, sources);
  }
  return out;
}

const NETWORK_SCHEMES = ["http:", "https:", "ws:", "wss:", "*", "'self'", "data:"];

describe("vault policy", () => {
  const csp = directives(headersFor("vault")["Content-Security-Policy"]!);

  test.each([
    ["default-src", ["'none'"]],
    ["connect-src", ["blob:"]],
    ["form-action", ["'none'"]],
    ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["img-src", ["blob:", "data:"]],
    ["style-src", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
    ["base-uri", ["'none'"]],
  ])("%s is %p", (name, sources) => {
    expect(csp.get(name)).toEqual(sources);
  });

  test("connect-src allows no network scheme, not even its own origin", () => {
    for (const scheme of NETWORK_SCHEMES) expect(csp.get("connect-src")).not.toContain(scheme);
  });

  test("no directive allows inline script or eval", () => {
    for (const sources of csp.values()) {
      expect(sources).not.toContain("'unsafe-inline'");
      expect(sources).not.toContain("'unsafe-eval'");
    }
  });

  test("the other response headers are present", () => {
    const h = headersFor("vault");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Connection-Allowlist"]).toBe("(response-origin)");
    expect(h["X-DNS-Prefetch-Control"]).toBe("off");
    const permissions = h["Permissions-Policy"]!.split(", ");
    for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()"]) {
      expect(permissions).toContain(feature);
    }
  });
});

describe("worker scripts carry the vault policy", () => {
  test("script CSP equals the vault CSP", () => {
    expect(headersFor("script")["Content-Security-Policy"]).toBe(VAULT_CSP);
    expect(headersFor("script")["Connection-Allowlist"]).toBe("(response-origin)");
    expect(headersFor("script")["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("loader policy", () => {
  const csp = directives(headersFor("loader")["Content-Security-Policy"]!);
  test("own origin only, no inline script, no form posts", () => {
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("frame-src")).toEqual(["'self'"]);
    expect(csp.get("worker-src")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
  });
  test("document headers", () => {
    const h = headersFor("loader");
    for (const name of [
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
    ]) {
      expect(h[name]).toBeDefined();
    }
  });
});

describe("asset policy", () => {
  test("a directly opened asset renders sandboxed with nothing allowed", () => {
    const csp = directives(headersFor("asset")["Content-Security-Policy"]!);
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.has("sandbox")).toBe(true);
    expect(headersFor("asset")["X-Content-Type-Options"]).toBe("nosniff");
  });
});

test("headersFor returns a fresh object", () => {
  const a = headersFor("vault");
  a["Content-Security-Policy"] = "tampered";
  expect(headersFor("vault")["Content-Security-Policy"]).toBe(VAULT_CSP);
});

describe("path routing", () => {
  test.each<[string, HeaderTarget]>([
    ["/lab/", "loader"],
    ["/lab", "loader"],
    ["/lab/index.html", "loader"],
    ["/lab/sw.js", "loader"],
    ["/lab/vault/", "vault"],
    ["/lab/vault/index.html", "vault"],
    ["/lab/assets/vault-zQpsO6UI.js", "script"],
    ["/lab/assets/worker-abc.mjs", "script"],
    ["/lab/src/main.tsx", "script"],
    ["/lab/assets/tokens-BQrN1o1g.css", "asset"],
    ["/lab/cas/" + "e".repeat(64), "asset"],
    ["/lab/manifest.json", "asset"],
    ["/elsewhere/index.html", "asset"],
  ])("%s -> %s", (path, target) => {
    expect(targetForPath(path)).toBe(target);
  });

  test("hashed files are immutable, everything else revalidates", () => {
    expect(cacheControlFor("/lab/assets/vault-zQpsO6UI.js")).toBe(IMMUTABLE_CACHE);
    expect(cacheControlFor(`/lab/cas/${"e".repeat(64)}`)).toBe(IMMUTABLE_CACHE);
    expect(cacheControlFor("/lab/manifest.json")).toBe(REVALIDATE_CACHE);
    expect(cacheControlFor("/lab/sw.js")).toBe(REVALIDATE_CACHE);
    expect(cacheControlFor("/lab/vault/")).toBe(REVALIDATE_CACHE);
  });

  test("headersForPath combines the target headers and Cache-Control", () => {
    expect(headersForPath("/lab/vault/")).toEqual({ ...headersFor("vault"), "Cache-Control": REVALIDATE_CACHE });
  });
});
