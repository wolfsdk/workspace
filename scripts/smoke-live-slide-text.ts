// Exercise a built workspace and a released native engine with two isolated browser sessions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, type Browser, type Page } from "playwright-core";
import { WorkspaceApi } from "../apps/workspace/src/lib/api.ts";

const engine = process.env.WOLF_ENGINE;
if (!engine) throw new Error("Set WOLF_ENGINE to the released wolf executable");
const fixture = Bun.file("fixtures/pptx/mixed-runs.pptx");
const digest = "bbbc18e63c55a144db33f15c0e31622feef061ed3e5387a697be224e275ed587";
const bytes = await fixture.arrayBuffer();
assert.equal(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), digest, "review the changed fixture before allowing edits");
const work = await mkdtemp(join(tmpdir(), "workspace-slides-"));
const out = process.env.LIVE_PROOF_DIR || work;
const doc = "mixed-runs.pptx", room = "demo";
const users = ["Ada", "Lin"].map(name => ({name, token:crypto.randomUUID()}));
const bold = "slide:#256/shape:#2/para:@1/run:@1", italic = "slide:#256/shape:#2/para:@1/run:@2";
const browsers: Browser[] = [];
const field = (p:Page, id:string) => p.locator(`[data-slide-run="${id}"]`);
const waitText = (p:Page, id:string, text:string) => p.waitForFunction(([id,text]) =>
  (document.querySelector(`[data-slide-run="${id}"]`) as HTMLInputElement | null)?.value === text, [id,text]);
await mkdir(out,{recursive:true});
await writeFile(join(work,"actors.json"),JSON.stringify(Object.fromEntries(users.map(u => [u.token,{kind:"user",id:u.name.toLowerCase(),name:u.name}]))),{mode:0o600});
const server = Bun.spawn([process.execPath,"packages/workspace-cli/src/cli.ts","serve","--host","127.0.0.1","--port","0","--pool","1","--engine",engine,"--db",join(work,"rooms.sqlite"),"--blobs",join(work,"blobs"),"--actors",join(work,"actors.json"),"--default-room",room,"--live-slide-text-attest",digest],{stdout:"pipe",stderr:"inherit"});
try {
  let origin = "", log = "";
  const reader = server.stdout.getReader();
  try {
    while (!origin) {
      const part = await reader.read();
      if (part.done) throw new Error("Room did not start: " + log);
      log += new TextDecoder().decode(part.value);
      const match = /^listening ws:\/\/127\.0\.0\.1:(\d+)\/ws$/m.exec(log);
      if (match) origin = `http://127.0.0.1:${match[1]}`;
    }
  } finally { reader.releaseLock(); }
  const api = new WorkspaceApi(origin,users[0]!.token);
  const initial = await api.upload(room,new File([bytes],doc));
  const clients:Page[] = [];
  for (const [i,[driver,executablePath]] of ([[chromium,process.env.CHROMIUM_PATH],[firefox,process.env.FIREFOX_PATH]] as const).entries()) {
    const browser = await driver.launch({headless:true,...(executablePath ? {executablePath} : {})});
    browsers.push(browser);
    const page = await browser.newPage({viewport:{width:1280,height:920},acceptDownloads:true});
    clients.push(page);
    page.setDefaultTimeout(20_000);
    await page.goto(`${origin}/?room=${room}`);
    await page.getByPlaceholder("Paste your token").fill(users[i]!.token);
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page.getByRole("option").filter({hasText:doc}).getByRole("button").first().click();
    await page.getByTestId("live-slide-text-open").click();
    await waitText(page,bold,"North");
  }
  const [ada,lin] = clients as [Page,Page];
  await field(ada,bold).fill("East");
  await field(lin,italic).fill("Coast");
  await field(ada,bold).press("Enter");
  await waitText(lin,bold,"East");
  assert.equal(await field(lin,italic).inputValue(),"Coast");
  await field(lin,italic).press("Enter");
  await waitText(ada,italic,"Coast");
  await field(ada,bold).fill("West");
  await field(lin,bold).fill("Lost draft");
  await field(ada,bold).press("Enter");
  await ada.locator(`[data-slide-run="${bold}"][data-current="West"]`).waitFor();
  await field(lin,bold).press("Enter");
  const conflict = lin.getByTestId("live-slide-text-conflict");
  await conflict.filter({hasText:"West"}).waitFor();
  assert.ok((await conflict.innerText()).includes("Lost draft"));
  if (process.env.LIVE_PROOF_DIR) await lin.screenshot({path:join(out,"conflict.png")});
  await lin.getByTestId("live-slide-text-use-current").click();
  await waitText(lin,bold,"West");
  const download = ada.waitForEvent("download");
  await ada.getByRole("button",{name:`Download head of ${doc}`}).click();
  const saved = join(out,"collaborative-result.pptx");
  await (await download).saveAs(saved);
  const head = await api.head(room,doc);
  assert.equal(head.revision,initial.revision + 3);
  assert.deepEqual(new Uint8Array(await readFile(saved)),head.bytes);
  const observe = join(work,"obs");
  execFileSync(engine,["observe",saved,"--outdir",observe]);
  const {nodes} = await Bun.file(join(observe,"collaborative-result.view.json")).json();
  const run = (id:string) => nodes.find((n:{id:string}) => n.id === id);
  assert.deepEqual([run(bold).text,run(bold).format.font.bold,run(italic).text,run(italic).format.font.italic],["West",true,"Coast",true]);
  const receipt = {wolf:execFileSync(engine,["--version"],{encoding:"utf8"}).trim(),browsers:browsers.map(b => [b.browserType().name(),b.version()]),revision:head.revision,downloadSha256:head.sha256,runs:[run(bold),run(italic)]};
  if (process.env.LIVE_PROOF_DIR) await writeFile(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify(receipt));
} finally {
  await Promise.allSettled(browsers.map(b => b.close()));
  server.kill(); await server.exited;
  await rm(work,{recursive:true,force:true});
}
