import { describe, expect, test } from "bun:test";
import {
  describeEngine,
  engineSourceFor,
  formatOfFile,
  initialTheme,
  isReviewable,
  mentionsIn,
  roomIdFrom,
  shortSha,
  takeToken,
  THEME_KEY,
  TOKEN_KEY,
} from "../src/lib/session.ts";
import { ALICE, SCOUT } from "./fixtures.ts";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("takeToken", () => {
  test("takes ?token=, stores it for the tab, and drops it from the address", () => {
    const storage = memory();
    expect(takeToken("?room=q3&token=abc&doc=memo.docx", storage)).toEqual({ token: "abc", search: "?room=q3&doc=memo.docx" });
    expect(storage.values.get(TOKEN_KEY)).toBe("abc");
    expect(takeToken("?token=abc", memory())).toEqual({ token: "abc", search: "" });
  });

  test("falls back to the stored token", () => {
    expect(takeToken("?room=q3", memory({ [TOKEN_KEY]: "stored" }))).toEqual({ token: "stored", search: "?room=q3" });
    expect(takeToken("", memory())).toEqual({ token: null, search: "" });
  });
});

describe("engineSourceFor", () => {
  const origin = "http://127.0.0.1:8787";

  test("a .wasm URL is a module, anything else a channel", () => {
    expect(engineSourceFor("https://cdn.example.com/v1/wolf_web.wasm", false, origin)).toEqual({ url: "https://cdn.example.com/v1/wolf_web.wasm" });
    expect(engineSourceFor("https://cdn.example.com/wolf/", true, origin)).toEqual({ channel: "https://cdn.example.com/wolf" });
    expect(engineSourceFor("/wasm", false, origin)).toEqual({ channel: "http://127.0.0.1:8787/wasm" });
  });

  test("uses the server's /wasm channel when it serves one, else the release channel", () => {
    expect(engineSourceFor(null, true, origin)).toEqual({ channel: "http://127.0.0.1:8787/wasm" });
    expect(engineSourceFor(null, false, origin)).toBeNull();
    expect(engineSourceFor("  ", false, origin)).toBeNull();
  });

  test("describes the source", () => {
    expect(describeEngine(null)).toBe("Release channel");
    expect(describeEngine({ channel: "http://x/wasm" })).toBe("Channel http://x/wasm");
    expect(describeEngine({ url: "http://x/a.wasm" })).toBe("Module http://x/a.wasm");
  });
});

describe("files and names", () => {
  test("infers the format from the extension", () => {
    expect(["a.docx", "B.XLSX", "deck.final.pptx", "scan.pdf", "notes.txt", "noext"].map(formatOfFile)).toEqual([
      "docx",
      "xlsx",
      "pptx",
      "pdf",
      null,
      null,
    ]);
    expect(isReviewable("pdf")).toBe(false);
    expect(isReviewable("xlsx")).toBe(true);
  });

  test("turns typed text into a room id", () => {
    expect(roomIdFrom("  Q3 Close / Board  ")).toBe("q3-close-board");
    expect(roomIdFrom("---")).toBe("");
  });

  test("shortens a sha256", () => {
    expect(shortSha(`sha256:${"ab".repeat(32)}`)).toBe("abababab");
  });
});

describe("mentionsIn", () => {
  test("finds actors by @id or by @name without spaces", () => {
    expect(mentionsIn("@scout please check, cc @AliceChen", [ALICE, SCOUT])).toEqual([
      { kind: "user", id: "alice" },
      { kind: "agent", id: "scout" },
    ]);
    expect(mentionsIn("no mentions here, email a@b", [ALICE, SCOUT])).toEqual([]);
  });
});

describe("initialTheme", () => {
  test("prefers the stored theme, then the system", () => {
    expect(initialTheme(memory({ [THEME_KEY]: "dark" }), false)).toBe("dark");
    expect(initialTheme(memory({ [THEME_KEY]: "nonsense" }), true)).toBe("dark");
    expect(initialTheme(memory(), false)).toBe("light");
  });
});
