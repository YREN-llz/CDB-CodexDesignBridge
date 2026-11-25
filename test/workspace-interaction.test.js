import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalWorkspaceServer } from "../codex-plugin/codex-design-bridge/mcp/local-workspace-server.mjs";
import { solidVisualReference } from "./helpers/visual-reference.js";

test("HTML preview supports buttons, forms, scrolling and navigation while zoomed", async (t) => {
  const modules = process.env.CODEX_WORKSPACE_NODE_MODULES || process.env.CODEX_NODE_MODULES ||
    path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
  const playwrightPath = path.join(modules, "playwright/index.mjs");
  try { await stat(playwrightPath); } catch {
    return t.skip("Bundled Playwright is unavailable");
  }
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const browser = await chromium.launch({
    executablePath: process.env.CDB_TEST_BROWSER || (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const preview = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/next.html") return response.end("<h1>Next page</h1>");
    response.end(`<!doctype html><html><body style="padding-top:100px">
      <button onclick="this.textContent='Clicked'">Click me</button>
      <form onsubmit="event.preventDefault(); document.querySelector('output').textContent=this.elements.name.value">
        <input name="name" aria-label="Name"><button>Submit</button><output></output>
      </form>
      <a href="/next.html">Next</a><div style="height:2200px">Scrollable page</div>
    </body></html>`);
  });
  await new Promise((resolve) => preview.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => preview.close(resolve)));
  const previewUrl = `http://127.0.0.1:${preview.address().port}/`;
  const workspace = {
    mode: "workspace", phase: "ready", projectDir: "/test", projectName: "Interaction test",
    pages: [{ id: "home", name: "Home", path: "/", viewport: { width: 390, height: 844 } }],
    activePageId: "home", previewUrl, previewRevision: 1, sessionActive: true,
    preflightReport: { projectKey: "test-project", status: "pass" },
    designOffers: [{
      offerId: "offer-other-project",
      rootName: "Other project page",
      linkedProjectKey: "other-project",
      linkedPageId: "other-page",
      state: "pending",
    }],
  };
  let screenshots = 0;
  let acceptedOffer;
  let acceptAttempts = 0;
  const html = await readFile(process.env.CDB_WORKSPACE_HTML_PATH ||
    new URL("../codex-plugin/codex-design-bridge/mcp/workspace.html", import.meta.url), "utf8");
  const server = await startLocalWorkspaceServer({
    port: 0,
    handleRequest: async (method, params) => {
      if (method === "resources/read") return { contents: [{ text: html }] };
      if (params.name === "get_cdb_health") return { structuredContent: { health: { activeProject: "/test" } } };
      if (params.name === "accept_figma_design_offer") {
        acceptedOffer = params.arguments;
        if (++acceptAttempts === 1) {
          return { isError: true, content: [{ type: "text", text: "Figma 已断开，请重新打开 CDB 插件" }] };
        }
      }
      if (params.name === "get_design_preview_image") {
        screenshots += 1;
        const image = solidVisualReference(100, 100);
        return {
          structuredContent: {
            workspace,
            previewImage: { width: 390, height: 2200, dataUrl: `data:image/png;base64,${image.base64}` },
          },
        };
      }
      return { structuredContent: { workspace } };
    },
  });
  t.after(() => server.stop());
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
  await page.goto(server.url);
  const frame = page.frameLocator("#preview");
  await frame.getByRole("button", { name: "Click me" }).click();
  await frame.getByRole("button", { name: "Clicked" }).waitFor();
  await frame.getByLabel("Name").fill("Ada");
  await frame.getByRole("button", { name: "Submit" }).click();
  assert.equal(await frame.locator("output").textContent(), "Ada");
  await page.getByRole("button", { name: "放大视图" }).click();
  await page.getByRole("button", { name: "放大视图" }).click();
  assert.equal(await page.locator("#preview").evaluate((element) => getComputedStyle(element).pointerEvents), "auto");
  await frame.getByRole("button", { name: "Clicked" }).click();
  const inner = page.frames().find((candidate) => candidate.url() === previewUrl);
  await inner.evaluate(() => window.scrollTo(0, 500));
  assert.ok(await inner.evaluate(() => window.scrollY) > 0);
  await frame.getByRole("link", { name: "Next" }).click();
  await frame.getByRole("heading", { name: "Next page" }).waitFor();
  assert.equal(screenshots, 0);
  assert.equal(await page.locator("#previewFallback").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "更新关联页面", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "创建独立项目", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Figma 已断开，请重新打开 CDB 插件" }).waitFor();
  await page.getByRole("button", { name: "创建独立项目", exact: true }).click();
  assert.equal(acceptedOffer.action, "create_project");
  assert.equal(acceptedOffer.offerId, "offer-other-project");
  await page.getByRole("button", { name: "切换到完整页面静态预览" }).click();
  await page.locator("#previewFallback").waitFor({ state: "visible" });
  assert.equal(screenshots, 1);
  await page.getByRole("button", { name: "返回可交互 HTML 预览" }).click();
  await page.locator("#loadingState").waitFor({ state: "hidden" });
  await frame.getByRole("button", { name: "Click me" }).click();
  await frame.getByRole("button", { name: "Clicked" }).waitFor();
  assert.equal(await page.locator("#previewFallback").isVisible(), false);
});
