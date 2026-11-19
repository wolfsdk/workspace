// Run against the built UI and a released native engine; no external accounts or browser profiles.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, type Browser, type Page } from "playwright-core";
import { WorkspaceApi } from "../apps/workspace/src/lib/api.ts";

const engine = process.env.WOLF_ENGINE;
if (!engine) throw new Error("Set WOLF_ENGINE to the released wolf executable");
const work = await mkdtemp(join(tmpdir(), "workspace-cells-"));
const out = process.env.LIVE_PROOF_DIR || work;
const original = "fixtures/xlsx/model-finance.xlsx";
// Exact reviewed finance fixture, ordinary formulas and unprotected cells. Do not trust replacement bytes.
const fixtureDigest = "cace063417422dba0ff6db8236e7554d7afb68965c6084445b5542708f9f23e7";
const doc = "finance.xlsx";
const names = ["Ada", "Lin"];
const tokens = names.map(() => crypto.randomUUID());
const browsers: Browser[] = [];
const clients: Page[] = [];
const field = (p: Page) => p.getByTestId("live-cells-input");
const cell = (p: Page, ref: string) => p.locator(`[data-live-cell="${ref}"]`);
async function draft(p: Page, ref: string, value: string) {
  await cell(p, ref).click();
  await field(p).fill(value);
}
async function waitCell(p: Page, ref: string, value: string) {
  await p.waitForFunction(([r,v]) => document.querySelector(`[data-live-cell="${r}"]`)?.getAttribute("data-value") === v, [ref,value]);
}
async function listen(proc: ReturnType<typeof spawnRoom>) {
  const reader = proc.stdout.getReader(); let output = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error("Room server stopped before listening");
      output += new TextDecoder().decode(part.value);
      const match = /^listening ws:\/\/127\.0\.0\.1:(\d+)\/ws$/m.exec(output);
      if (match) return `http://127.0.0.1:${match[1]}`;
    }
  } finally { reader.releaseLock(); }
}
function spawnRoom() {
  return Bun.spawn([process.execPath, "packages/workspace-cli/src/cli.ts", "serve",
    "--host", "127.0.0.1", "--port", "0", "--pool", "1", "--engine", engine!,
    "--db", join(work,"rooms.sqlite"), "--blobs", join(work,"blobs"), "--actors", join(work,"actors.json"),
    "--default-room", "demo", "--live-cells-attest", fixtureDigest], {stdout:"pipe",stderr:"inherit"});
}
let server: ReturnType<typeof spawnRoom> | undefined;
try {
  await mkdir(out, {recursive:true});
  await writeFile(join(work,"actors.json"), JSON.stringify(Object.fromEntries(tokens.map((t,i) => [t,{kind:"user",id:names[i]!.toLowerCase(),name:names[i]}]))), {mode:0o600});
  server = spawnRoom();
  const origin = await listen(server);
  const api = new WorkspaceApi(origin, tokens[0]!);
  const initial = await api.upload("demo", new File([await Bun.file(original).arrayBuffer()],doc));
  assert.equal(initial.sha256,fixtureDigest,"review the workbook before admitting a changed test fixture");
  for (const [driver, executablePath] of [[chromium,process.env.CHROMIUM_PATH],[firefox,process.env.FIREFOX_PATH]] as const) {
    browsers.push(await driver.launch({headless:true,...(executablePath ? {executablePath} : {})}));
  }
  await Promise.all(browsers.map(async (browser,i) => {
    const page = await browser.newPage({viewport:{width:1280,height:920},acceptDownloads:true});
    clients[i] = page; page.setDefaultTimeout(25_000);
    await page.goto(`${origin}/?room=demo`);
    await page.getByPlaceholder("Paste your token").fill(tokens[i]!);
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page.getByRole("option").filter({hasText:doc}).getByRole("button").first().click();
    await page.getByTestId("live-cells-open").click();
    await waitCell(page,"B2","1000");
  }));
  const [ada,lin] = clients as [Page,Page];
  // Pin both drafts before either writes; presence is rendered on the other browser's cell.
  await draft(ada,"B2","2000");
  await draft(lin,"B3","0.125");
  await lin.locator('[data-peer-cell="B2"]').filter({hasText:"Ada"}).first().waitFor();
  await field(ada).press("Enter");
  await waitCell(lin,"B2","2000");
  assert.equal(await field(lin).inputValue(),"0.125");
  await field(lin).press("Enter");
  await waitCell(ada,"B3","0.125");
  // Keep complete formulas atomic. Two competing edits start from the same original input.
  await draft(ada,"B2","=B3*8192");
  await draft(lin,"B2","=B3*2");
  await field(ada).press("Enter");
  await ada.waitForFunction(() => document.querySelector('[data-live-cell="B2"]')?.getAttribute('data-dirty') !== 'true');
  await field(lin).press("Enter");
  await lin.getByTestId("live-cells-conflict").waitFor();
  assert.equal(await field(lin).inputValue(),"=B3*2");
  const message = await lin.getByTestId("live-cells-conflict").innerText();
  assert.ok(message.includes("=B3*2") && message.includes("=B3*8192"),"show both expressions before asking which to keep");
  if (process.env.LIVE_PROOF_DIR) await lin.screenshot({path:join(out,"conflict.png")});
  await lin.getByTestId("live-cells-use-current").click();
  await Promise.all(clients.map(p => waitCell(p,"B2","=B3*8192")));
  const dl = ada.waitForEvent("download");
  await ada.getByRole("button",{name:`Download head of ${doc}`}).click();
  const saved = join(out,"collaborative-result.xlsx");
  await (await dl).saveAs(saved);
  const head = await api.head("demo",doc);
  assert.deepEqual(new Uint8Array(await readFile(saved)),head.bytes);
  assert.equal(head.revision,initial.revision + 3,"the losing formula must not create a revision");
  const observe = join(work,"observed");
  execFileSync(engine,["observe",saved,"--outdir",observe]);
  const {nodes} = JSON.parse(await readFile(join(observe,"collaborative-result.view.json"),"utf8"));
  const byId = new Map<string,{value?:unknown;formula?:string}>(nodes.map((n:{id:string}) => [n.id,n]));
  assert.equal(byId.get("sheet:#1/cell:B2")?.formula,"=B3*8192");
  assert.deepEqual(byId.get("sheet:#1/cell:B3")?.value,{number:0.125});
  assert.equal(byId.get("sheet:#2/cell:B2")?.formula,"=Assumptions!B2*(1+Growth)");
  // The downloaded oracle workbook is pinned above. Now exercise Reapply on another cell.
  await draft(ada,"B4","=1/4");
  await draft(lin,"B4","=1/5");
  await field(ada).press("Enter");
  const conflict = lin.getByTestId("live-cells-conflict");
  await conflict.filter({hasText:"=1/4"}).waitFor();
  await draft(ada,"B4","=1/8");
  await field(ada).press("Enter");
  await waitCell(lin,"B4","=1/8");
  assert.ok((await conflict.innerText()).includes("=1/4"),"the displayed conflict still refers to the older winner");
  const beforeReapply = (await api.head("demo",doc)).revision;
  await lin.getByTestId("live-cells-reapply").click();
  await conflict.filter({hasText:"=1/8"}).waitFor();
  assert.equal((await api.head("demo",doc)).revision,beforeReapply,"do not overwrite an unseen change");
  await lin.getByTestId("live-cells-reapply").click();
  await waitCell(ada,"B4","=1/5");
  const receipt = {browsers:browsers.map(b=>({engine:b.browserType().name(),version:b.version()})),wolf:execFileSync(engine,["--version"],{encoding:"utf8"}).trim(),revision:head.revision,downloadSha256:head.sha256,disjointEdits:true,conflictKeptWinner:true,remoteSelection:true};
  if (process.env.LIVE_PROOF_DIR) { await writeFile(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n"); await ada.screenshot({path:join(out,"cells.png")}); }
  console.log(JSON.stringify(receipt));
} catch (e) {
  for (const [i,p] of clients.entries()) if (p && !p.isClosed()) {
    const facts = await p.locator('[data-live-cell="B2"], [data-live-cell="B3"], [data-testid="live-cells-conflict"], [role="alert"]').allTextContents().catch(()=>[]);
    console.error(names[i],JSON.stringify(facts));
    if (process.env.LIVE_PROOF_DIR) await p.screenshot({path:join(out,`failed-${i}.png`)}).catch(()=>{});
  }
  throw e;
} finally {
  await Promise.allSettled(browsers.map(b=>b.close()));
  if (server) { server.kill(); await server.exited; }
  await rm(work,{recursive:true,force:true});
}
