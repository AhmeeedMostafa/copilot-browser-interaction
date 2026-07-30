import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLineDecoder, createNativeDecoder, encodeNative, writeLine } from "../src/protocol.mjs";

test("MCP reaches the browser through the native host", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const testDirectory = fs.mkdtempSync("/tmp/copilot-open-tabs-");
  const env = {
    ...process.env,
    COPILOT_OPEN_TABS_SOCKET: path.join(testDirectory, "bridge.sock")
  };
  const mcp = spawn(process.execPath, [path.join(root, "src/mcp.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env
  });
  let host;
  t.after(() => {
    host?.kill();
    mcp.kill();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });
  const responses = new Map();
  mcp.stdout.on("data", createLineDecoder((message) => responses.set(message.id, message)));

  writeLine(mcp.stdin, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  writeLine(mcp.stdin, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  writeLine(mcp.stdin, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_browser_tabs", arguments: {} }
  });

  await waitFor(() => responses.size === 3);
  assert.equal(responses.get(1).result.protocolVersion, "2025-06-18");
  assert.deepEqual(
    responses.get(2).result.tools.map((tool) => tool.name),
    [
      "list_browser_tabs",
      "open_browser_tab",
      "close_browser_tab",
      "navigate_browser_tab",
      "browser_tab_history",
      "read_browser_tab",
      "take_browser_screenshot",
      "click_browser_element",
      "type_in_browser_element",
      "press_browser_key",
      "hover_browser_element",
      "drag_browser_element",
      "select_browser_option",
      "scroll_browser_tab",
      "wait_for_browser",
      "handle_browser_dialog",
      "highlight_browser_text",
      "read_browser_console",
      "resize_browser_viewport"
    ]
  );
  assert.equal(responses.get(3).result.isError, true);
  assert.match(responses.get(3).result.content[0].text, /not connected/i);

  host = spawn(process.execPath, [path.join(root, "src/native-host.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env
  });
  const nativeMessages = [];
  host.stdout.on("data", createNativeDecoder((message) => nativeMessages.push(message)));
  await waitFor(() => nativeMessages.some((message) => message.event === "bridge_status" && message.connected));

  writeLine(mcp.stdin, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list_browser_tabs", arguments: {} }
  });
  await waitFor(() => nativeMessages.some((message) => message.method === "list_tabs"));
  const browserRequest = nativeMessages.find((message) => message.method === "list_tabs");
  host.stdin.write(encodeNative({ id: browserRequest.id, result: [{ id: 42, title: "Agent tab" }] }));
  await waitFor(() => responses.has(4));
  assert.match(responses.get(4).result.content[0].text, /Agent tab/);

  writeLine(mcp.stdin, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "take_browser_screenshot", arguments: { tabId: 42 } }
  });
  await waitFor(() => nativeMessages.some((message) => message.method === "screenshot"));
  const screenshotRequest = nativeMessages.find((message) => message.method === "screenshot");
  host.stdin.write(encodeNative({
    id: screenshotRequest.id,
    result: { data: "aW1hZ2U=", mimeType: "image/png", fullPage: false }
  }));
  await waitFor(() => responses.has(5));
  assert.deepEqual(responses.get(5).result.content[0], {
    type: "image",
    data: "aW1hZ2U=",
    mimeType: "image/png"
  });

  host.stdin.end();
  await new Promise((resolve) => host.once("exit", resolve));
  mcp.stdin.end();
  await new Promise((resolve) => mcp.once("exit", resolve));
});

async function waitFor(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for MCP responses");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
