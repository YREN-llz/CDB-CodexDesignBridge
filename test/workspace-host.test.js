import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL(
  "../codex-plugin/codex-design-bridge/mcp/workspace.html", import.meta.url,
), "utf8");

test("the embedded launcher is ready on a host that sends tool results only after initialization", async () => {
  const listeners = new Map();
  const elements = new Map();
  const sent = [];
  let poll;
  const workspace = {
    mode: "launcher",
    phase: "launcher_ready",
    launcherId: "launcher-test",
    workspaceDir: "/test-workspace",
    designOffers: [],
    message: "等待 Figma",
  };
  const result = { structuredContent: { workspace } };
  const parent = {
    postMessage(message) {
      sent.push(message.method);
      if (message.method === "ui/initialize") {
        assert.ok(message.params.appInfo.name);
        assert.ok(message.params.appCapabilities);
        receive({ id: message.id, result: { hostContext: { displayMode: "inline" } } });
      } else if (message.method === "ui/notifications/initialized") {
        receive({ method: "ui/notifications/tool-result", params: result });
      } else if (message.method === "tools/call") {
        assert.equal(message.params.name, "get_figma_design_offers");
        assert.equal(message.params.arguments.launcherId, workspace.launcherId);
        receive({ id: message.id, result });
      }
    },
  };
  function receive(message) {
    listeners.get("message")({ source: parent, data: { jsonrpc: "2.0", ...message } });
  }

  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window: {
      parent,
      addEventListener: (name, listener) => listeners.set(name, listener),
      setTimeout,
      setInterval: (callback) => { poll = callback; return 1; },
    },
    document: {
      addEventListener() {},
      getElementById: (id) => {
        if (!elements.has(id)) {
          elements.set(id, {
            addEventListener() {},
            replaceChildren() {},
            removeAttribute() {},
            setAttribute() {},
            style: { setProperty() {} },
            classList: { toggle() {} },
          });
        }
        return elements.get(id);
      },
    },
    location: { hash: "" },
    getComputedStyle: () => ({}),
    clearTimeout,
  });
  await setImmediate();

  assert.deepEqual(sent, ["ui/initialize", "ui/notifications/initialized"]);
  assert.equal(elements.get("launcherView").hidden, false);
  assert.equal(elements.get("launcherStatus").textContent, "等待 Figma");
  await poll();
  assert.equal(sent.at(-1), "tools/call");
});
