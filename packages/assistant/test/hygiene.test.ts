// The package is a prompt layer over this workspace: no provider SDK, nothing from outside it.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { ASSISTANT_DOC_FORMATS, assistantDocFormat, operationGuide } from "../src/index.ts";

const SRC = join(import.meta.dir, "..", "src");

test("every dependency is a package of this workspace", () => {
  const sections = manifest as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  const dependencies = { ...sections.dependencies, ...sections.devDependencies, ...sections.peerDependencies };
  expect(Object.keys(dependencies)).toEqual(["@wolfsdk/protocol"]);
  expect(Object.values(dependencies)).toEqual(["workspace:*"]);
});

test("the sources import the protocol package and each other, nothing else", () => {
  const imported = readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => [...readFileSync(join(SRC, file), "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1] as string));
  expect(imported.length).toBeGreaterThan(0);
  expect(imported.filter((specifier) => !specifier.startsWith("./") && specifier !== "@wolfsdk/protocol/workspace")).toEqual([]);
});

test("each format has its own guide, found by a document's extension", () => {
  const guides = ASSISTANT_DOC_FORMATS.map(operationGuide);
  expect(new Set(guides).size).toBe(ASSISTANT_DOC_FORMATS.length);
  expect(assistantDocFormat("Q3 Forecast.XLSX")).toBe("xlsx");
  expect(assistantDocFormat("deck.final.pptx")).toBe("pptx");
  expect(assistantDocFormat("notes.txt")).toBeNull();
  expect(assistantDocFormat("docx")).toBeNull();
  expect(assistantDocFormat(null)).toBeNull();
});
