/** @jsxImportSource preact */
import { expect, test } from "bun:test";
import { TID } from "../src/lab/index.ts";
import { FakeLabEngine, sampleFile } from "../src/lab/testing.ts";
import { render } from "preact-render-to-string";
import { CodeDrawer, toBatches } from "../src/codegen/index.ts";

test("renders every tab, the batch file first, and the pinned environment", async () => {
  const engine = new FakeLabEngine();
  const opened = await engine.openFile(sampleFile.bytes, sampleFile.name);
  const doc = await engine.apply(opened, [{ op: "set", target: "sheet:#1/cell:A1", value: { number: 1 } }], "Set A1");
  const journal = engine.journal(doc);
  const html = render(<CodeDrawer journal={journal} />);
  for (const kind of ["batches", "cli", "python", "mcp", "typescript"] as const) {
    expect(html).toContain(`data-testid="${TID.codeTab(kind)}"`);
  }
  expect(html).toMatch(new RegExp(`data-testid="${TID.codeTab("batches")}"[^>]*>Batches<`));
  expect(html).toContain('aria-selected="true"');
  const text = html.match(new RegExp(`<pre[^>]*data-testid="${TID.codeText}"[^>]*>([\\s\\S]*?)</pre>`))?.[1];
  expect(text).toBeDefined();
  const decoded = text!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  expect(JSON.parse(decoded)).toEqual(toBatches(journal));
  const { clock, timezone, locale, seed } = journal.environment;
  expect(html).toContain(`Pinned environment: clock ${clock}, time zone ${timezone}, locale ${locale}, seed ${seed}.`);
  expect(html).not.toContain("\u2014");
});
