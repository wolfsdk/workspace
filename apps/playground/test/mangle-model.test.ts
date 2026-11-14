import { describe, expect, test } from "bun:test";
import { type EditIntent, type LabRivals, type LabStep, MEMBER_VERDICTS, type RivalRecord } from "../src/lab/index.ts";
import { sampleDelta, samplePackage } from "../src/lab/testing.ts";
import {
  changedBytes,
  countRows,
  defaultIntentFor,
  initialLanes,
  intentLabel,
  intentValid,
  kernelErrorOf,
  lossItems,
  noLaneMessage,
  NOT_RUN,
  offeredRivals,
  rivalLaneFromFailure,
  rivalLaneFromRecord,
  rivalLaneUnsupported,
  runningLane,
  verdictClass,
  verdictLabel,
  wolfLaneFromFailure,
  wolfLaneFromStep,
  wolfLaneNoOps,
} from "../src/modes/mangle-off/model.ts";

const intent: EditIntent = { kind: "set-cell", sheet: "Model", a1: "B2", value: 1200 };

function deltaWith(verdicts: Record<string, (typeof MEMBER_VERDICTS)[number]>) {
  const delta = sampleDelta([]);
  const counts = { ...delta.counts };
  for (const key of MEMBER_VERDICTS) counts[key] = 0;
  const members = delta.verdicts.map((m) => {
    const verdict = verdicts[m.name] ?? "identical-stream";
    counts[verdict]++;
    return { ...m, verdict, bytesAfter: verdict === "removed" ? 0 : m.bytesAfter };
  });
  return { ...delta, verdicts: members, counts };
}

const record = (overrides: Partial<RivalRecord> = {}): RivalRecord => ({
  rival: "openpyxl",
  version: "3.1.5",
  intent,
  ok: true,
  delta: deltaWith({ "xl/worksheets/sheet1.xml": "changed", "xl/styles.xml": "xml-equivalent", "xl/sharedStrings.xml": "removed" }),
  losses: [{ category: "shared strings", members: ["xl/sharedStrings.xml"], severity: "data-loss" }],
  ms: 5,
  ...overrides,
});

describe("verdict wording", () => {
  test("only identical-stream is untouched", () => {
    const untouched = MEMBER_VERDICTS.filter((v) => verdictClass(v) === "untouched");
    expect(untouched).toEqual(["identical-stream"]);
    for (const v of MEMBER_VERDICTS) {
      if (v !== "identical-stream") expect(verdictLabel(v).toLowerCase()).not.toContain("untouched");
    }
    expect(verdictLabel("identical-stream")).toBe("Untouched");
  });

  test("recompressed and xml-equivalent read as rewritten without content change", () => {
    for (const v of ["same-bytes-recompressed", "xml-equivalent"] as const) {
      expect(verdictClass(v)).toBe("rewritten");
      expect(verdictLabel(v)).toStartWith("Rewritten without content change");
    }
  });

  test("removed is lost; changed and added keep their names", () => {
    expect(verdictClass("removed")).toBe("lost");
    expect(verdictLabel("removed")).toBe("Lost");
    expect(verdictLabel("changed")).toBe("Changed");
    expect(verdictLabel("added")).toBe("Added");
  });

  test("no user-visible wording has an em dash", () => {
    for (const v of MEMBER_VERDICTS) expect(verdictLabel(v)).not.toContain("\u2014");
    expect(noLaneMessage("docx")).not.toContain("\u2014");
  });

  test("count rows follow the delta counts in verdict order", () => {
    const delta = deltaWith({ "xl/styles.xml": "same-bytes-recompressed", "xl/workbook.xml": "removed" });
    const rows = countRows(delta);
    expect(rows.map((r) => r.verdict)).toEqual([...MEMBER_VERDICTS]);
    expect(rows.find((r) => r.verdict === "removed")?.count).toBe(1);
    expect(rows.find((r) => r.verdict === "same-bytes-recompressed")?.count).toBe(1);
    expect(rows.find((r) => r.verdict === "identical-stream")?.count).toBe(3);
  });

  test("changed bytes skip untouched members and count removed by their old size", () => {
    const delta = deltaWith({ "xl/styles.xml": "changed", "xl/workbook.xml": "removed" });
    expect(changedBytes(delta)).toBe(1800 + 600);
  });
});

describe("loss list", () => {
  test("rival losses come first, then delta members the records do not name", () => {
    const items = lossItems(record().delta!, record().losses);
    expect(items[0]).toEqual({ kind: "lost", label: "Lost: shared strings", members: ["xl/sharedStrings.xml"] });
    expect(items.filter((i) => i.members.includes("xl/sharedStrings.xml"))).toHaveLength(1);
    const styles = items.find((i) => i.members.includes("xl/styles.xml"));
    expect(styles?.kind).toBe("rewritten");
    expect(styles?.label).toStartWith("Rewritten without content change");
    expect(items.some((i) => i.members.includes("xl/worksheets/sheet1.xml"))).toBe(false);
  });

  test("rewrite severity is not called lost", () => {
    const items = lossItems(null, [{ category: "styles", members: ["xl/styles.xml"], severity: "rewrite" }]);
    expect(items).toEqual([{ kind: "rewritten", label: "Rewritten without content change: styles", members: ["xl/styles.xml"] }]);
  });

  test("a delta with only identical streams and the edited part has no losses", () => {
    expect(lossItems(sampleDelta())).toEqual([]);
  });
});

describe("rivals offered for a format", () => {
  test("offers the rivals the runner supports for the format's edit or a pasted script", () => {
    const editOnly: LabRivals["supports"] = (rival, format, kind) => rival === "openpyxl" && format === "xlsx" && kind === "set-cell";
    expect(offeredRivals(editOnly, "xlsx")).toEqual([{ rival: "openpyxl" }]);
    expect(offeredRivals(editOnly, "docx")).toEqual([]);
    const scriptOnly: LabRivals["supports"] = (rival, format, kind) => rival === "python-pptx" && format === "pptx" && kind === "user-script";
    expect(offeredRivals(scriptOnly, "pptx")).toEqual([{ rival: "python-pptx" }]);
    expect(offeredRivals(() => false, "pptx")).toEqual([]);
  });

  test("the empty case explains that no lane is shown", () => {
    expect(noLaneMessage("pptx")).toBe("No rival library edits PPTX files here.");
  });
});

describe("intents", () => {
  test("the edit form starts empty for the format's editable kind", () => {
    expect(defaultIntentFor("xlsx")).toEqual({ kind: "set-cell", sheet: "", a1: "", value: "" });
    expect(defaultIntentFor("docx")).toEqual({ kind: "replace-text", find: "", replace: "" });
    expect(defaultIntentFor("pptx")).toEqual({ kind: "set-shape-text", slide: 1, shape: "", text: "" });
    expect(intentValid(defaultIntentFor("xlsx"))).toBe(false);
  });

  test("validity per kind", () => {
    expect(intentValid(intent)).toBe(true);
    expect(intentValid({ kind: "set-cell", sheet: "", a1: "B2", value: 1 })).toBe(false);
    expect(intentValid({ kind: "replace-text", find: "", replace: "x" })).toBe(false);
    expect(intentValid({ kind: "set-shape-text", slide: 0, shape: "Title 1", text: "x" })).toBe(false);
    expect(intentValid({ kind: "user-script", python: "  " })).toBe(false);
  });

  test("labels read in plain English", () => {
    expect(intentLabel(intent)).toBe("Set Model!B2 to 1200");
    expect(intentLabel({ kind: "replace-text", find: "a", replace: "b" })).toBe('Replace "a" with "b"');
  });
});

describe("lane state from RivalRecord and PackageDelta", () => {
  test("a successful record is done with counts, losses and an engine-open preview", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const lane = rivalLaneFromRecord(record({ outputBytes: bytes }), samplePackage);
    expect(lane.state).toBe("done");
    expect(lane.title).toBe("openpyxl 3.1.5");
    expect(lane.delta?.counts.removed).toBe(1);
    expect(lane.info).toBe(lane.delta!.before);
    expect(lane.losses[0]?.kind).toBe("lost");
    expect(lane.error).toBeNull();
    expect(lane.preview).toEqual({ kind: "open-output", bytes });
  });

  test("a record without an output file has no preview", () => {
    const lane = rivalLaneFromRecord(record(), null);
    expect(lane.preview).toEqual({ kind: "none", reason: "The rival returned no output file." });
  });

  test("a rival exception is a shown result, not hidden", () => {
    const lane = rivalLaneFromRecord(record({ ok: false, error: "KeyError: 'Model'", delta: undefined, losses: [] }), samplePackage);
    expect(lane.state).toBe("error");
    expect(lane.error).toEqual({ kind: "exception", title: "openpyxl raised an error", detail: "KeyError: 'Model'" });
    expect(lane.info).toBe(samplePackage);
    expect(lane.delta).toBeNull();
  });

  test("stdout and stderr travel with the lane", () => {
    const lane = rivalLaneFromRecord(record({ intent: { kind: "user-script", python: "print(1)" }, stdout: "1\n", stderr: "" }), null);
    expect(lane.stdout).toBe("1\n");
    expect(lane.stderr).toBe("");
    expect(lane.caption).toBe("Your script");
  });

  test("a delta computed by the verifier overrides a missing record delta", () => {
    const computed = deltaWith({ "xl/styles.xml": "same-bytes-recompressed" });
    const lane = rivalLaneFromRecord(record({ delta: undefined, losses: [] }), null, computed);
    expect(lane.delta).toBe(computed);
    expect(lane.losses.map((l) => l.kind)).toEqual(["rewritten"]);
  });

  test("unsupported and thrown rival runs are results", () => {
    expect(rivalLaneUnsupported("python-docx", null, "x").error?.kind).toBe("unsupported");
    const failed = rivalLaneFromFailure("openpyxl", new Error("worker died"), null, "x");
    expect(failed.state).toBe("error");
    expect(failed.error?.detail).toBe("worker died");
  });
});

describe("wolf lane", () => {
  const step: LabStep = {
    index: 3,
    label: "Set Model!B2 to 1200",
    ops: [],
    baseSha256: "a",
    resultSha256: "b",
    changes: [],
    partsWritten: [],
    status: "applied",
    ms: 1,
  };

  test("an applied step is done with its rendered page and result sha256", () => {
    const png = { kind: "png" as const, png: new Uint8Array([1]) };
    const lane = wolfLaneFromStep(step, sampleDelta(), samplePackage, png, "result-sha");
    expect(lane.state).toBe("done");
    expect(lane.delta?.counts["identical-stream"]).toBe(4);
    expect(lane.preview).toBe(png);
    expect(lane.resultSha256).toBe("result-sha");
    expect(runningLane(lane, "again").resultSha256).toBeNull();
  });

  test("a conflict is shown as the result with the kernel error", () => {
    const lane = wolfLaneFromStep(
      { ...step, status: "conflict", error: { code: "address-unresolved", message: "gone" } },
      null,
      samplePackage,
      { kind: "none", reason: "x" },
      "a",
    );
    expect(lane.state).toBe("error");
    expect(lane.error).toEqual({ kind: "conflict", title: "Wolf reported a conflict", code: "address-unresolved", detail: "gone" });
  });

  test("a refusal carries the KernelError code and message", () => {
    const error = new Error("refused", { cause: { code: "address-unresolved", message: "no sheet Model" } });
    expect(kernelErrorOf(error)?.code).toBe("address-unresolved");
    const lane = wolfLaneFromFailure(error, samplePackage, "x");
    expect(lane.state).toBe("error");
    expect(lane.error).toEqual({ kind: "refusal", title: "Wolf refused this edit", code: "address-unresolved", detail: "no sheet Model" });
    expect(lane.note).toBeNull();
  });

  test("a plain error without a kernel cause still shows", () => {
    expect(kernelErrorOf(new Error("x"))).toBeNull();
    expect(wolfLaneFromFailure(new Error("boom"), null, "x").error?.detail).toBe("boom");
    expect(wolfLaneNoOps(null, "x").error?.kind).toBe("no-ops");
  });
});

describe("initial lanes", () => {
  test("both lanes start idle on the input's package", () => {
    const lanes = initialLanes({ rival: "openpyxl" }, samplePackage);
    expect(lanes.wolf.state).toBe("idle");
    expect(lanes.wolf.note).toBe(NOT_RUN);
    expect(lanes.wolf.info).toBe(samplePackage);
    expect(lanes.wolf.title).toBe("Wolf");
    expect(lanes.rival?.state).toBe("idle");
    expect(lanes.rival?.title).toBe("openpyxl");
    expect(lanes.rival?.info).toBe(samplePackage);
  });

  test("no offered rival means no rival lane", () => {
    const lanes = initialLanes(null, null);
    expect(lanes.rival).toBeNull();
  });
});
