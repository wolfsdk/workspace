import { describe, expect, test } from "bun:test";
import {
  EXTRACT_WHAT,
  isBlob,
  isUnknownCommand,
  lowerExtractArgs,
  lowerObserveArgs,
  moduleProblems,
  unpackResult,
} from "../src/reactor/abi.ts";

describe("isBlob", () => {
  test("is exactly {ptr, len} with integer members", () => {
    expect(isBlob({ ptr: 16, len: 4 })).toBe(true);
    expect(isBlob({ len: 0, ptr: 0 })).toBe(true);
    expect(isBlob({ ptr: 16 })).toBe(false);
    expect(isBlob({ ptr: 16, len: 4, extra: 1 })).toBe(false);
    expect(isBlob({ ptr: 1.5, len: 4 })).toBe(false);
    expect(isBlob({ ptr: "16", len: 4 })).toBe(false);
    expect(isBlob([16, 4])).toBe(false);
    expect(isBlob(null)).toBe(false);
  });
});

describe("unpackResult", () => {
  test("splits the high and low 32 bits", () => {
    expect(unpackResult((1024n << 32n) | 77n)).toEqual({ ptr: 1024, len: 77 });
    expect(unpackResult(0n)).toEqual({ ptr: 0, len: 0 });
  });

  test("reads a negative i64 as unsigned", () => {
    expect(unpackResult(-1n)).toEqual({ ptr: 0xffffffff, len: 0xffffffff });
    expect(unpackResult(BigInt.asIntN(64, (0x80000000n << 32n) | 5n))).toEqual({ ptr: 0x80000000, len: 5 });
  });
});

describe("isUnknownCommand", () => {
  test("only a bad-request refusal naming an unknown cmd", () => {
    expect(isUnknownCommand({ code: "bad-request", message: "unknown cmd damage_report" })).toBe(true);
    expect(isUnknownCommand({ code: "bad-request", message: "missing field doc" })).toBe(false);
    expect(isUnknownCommand({ code: "unknown-doc", message: "unknown cmd damage_report" })).toBe(false);
    expect(isUnknownCommand(undefined)).toBe(false);
  });
});

describe("moduleProblems", () => {
  test("lists every missing export of an empty module", () => {
    const empty = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    expect(moduleProblems(empty)).toEqual([
      "no export memory",
      "no export _initialize",
      "no export wolf_alloc",
      "no export wolf_free",
      "no export wolf_call",
    ]);
  });
});

describe("lowerObserveArgs", () => {
  test("lowers targets, channels, limits and render flags to options", () => {
    expect(
      lowerObserveArgs([
        "--target",
        "para:#1A000002",
        "--target",
        "sheet:Regions",
        "--channel",
        "text",
        "--depth",
        "2",
        "--max-nodes",
        "50",
        "--render",
        "png",
        "--dpi",
        "96",
        "--scale-to-x",
        "800",
        "--pages",
        "2-3",
      ]),
    ).toEqual({
      options: {
        targets: ["para:#1A000002", "sheet:Regions"],
        channels: ["text"],
        depth: 2,
        max_nodes: 50,
        render: { to: "png", dpi: 96, scale_to_x: 800, pages: { first: 2, last: 3 } },
      },
    });
  });

  test("page ranges: one page, open ends", () => {
    const pages = (value: string) => {
      const lowered = lowerObserveArgs(["--pages", value]);
      if (!("options" in lowered)) return lowered;
      const render = lowered.options.render;
      return render && typeof render === "object" && "pages" in render ? render.pages : undefined;
    };
    expect(pages("4")).toEqual({ first: 4, last: 4 });
    expect(pages("2-")).toEqual({ first: 2 });
    expect(pages("-5")).toEqual({ last: 5 });
  });

  test("returns the offending flag", () => {
    expect(lowerObserveArgs(["--clock", "2026-01-01T00:00:00Z"])).toMatchObject({ flag: "--clock" });
    expect(lowerObserveArgs(["--depth"])).toEqual({ flag: "--depth", message: "--depth needs a value" });
    expect(lowerObserveArgs(["--depth", "-1"])).toMatchObject({ flag: "--depth" });
    expect(lowerObserveArgs(["--dpi", "wide"])).toMatchObject({ flag: "--dpi" });
    expect(lowerObserveArgs(["--pages", "0"])).toMatchObject({ flag: "--pages" });
    expect(lowerObserveArgs(["--pages", "-"])).toMatchObject({ flag: "--pages" });
  });

  test("no flags is empty options", () => {
    expect(lowerObserveArgs([])).toEqual({ options: {} });
  });
});

describe("lowerExtractArgs", () => {
  test("--what repeats and takes comma lists, first-seen order without duplicates", () => {
    expect(lowerExtractArgs(["--what", "markdown, text", "--what", "text,chunks"])).toEqual({
      options: { what: ["markdown", "text", "chunks"] },
    });
  });

  test("accepts every documented channel", () => {
    expect(lowerExtractArgs(["--what", EXTRACT_WHAT.join(",")])).toEqual({ options: { what: [...EXTRACT_WHAT] } });
  });

  test("no --what leaves the engine default", () => {
    expect(lowerExtractArgs([])).toEqual({ options: {} });
  });

  test("returns the offending flag", () => {
    expect(lowerExtractArgs(["--format", "json"])).toMatchObject({ flag: "--format" });
    expect(lowerExtractArgs(["--what"])).toEqual({ flag: "--what", message: "--what needs a value" });
    expect(lowerExtractArgs(["--what", "text,pixels"])).toMatchObject({ flag: "--what" });
  });
});
