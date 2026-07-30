import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLineDecoder, createNativeDecoder, encodeNative, writeLine } from "../src/protocol.mjs";

test("shared daemon isolates conversations and browsers", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const testDirectory = fs.mkdtempSync("/tmp/copilot-open-tabs-");
  const env = {
    ...process.env,
    COPILOT_OPEN_TABS_SOCKET: path.join(testDirectory, "bridge.sock"),
    COPILOT_BROWSER_DAEMON_SOCKET: path.join(testDirectory, "daemon.sock")
  };
  const daemon = spawn(process.execPath, [path.join(root, "src/daemon.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  await waitFor(() => fs.existsSync(env.COPILOT_BROWSER_DAEMON_SOCKET));
  const mcp = spawn(process.execPath, [path.join(root, "src/mcp.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env
  });
  const hosts = [];
  t.after(() => {
    for (const { host } of hosts) host.kill();
    mcp.kill();
    daemon.kill();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const responses = new Map();
  mcp.stdout.on("data", createLineDecoder((message) => responses.set(message.id, message)));
  sendMcp(1, "initialize", { protocolVersion: "2025-06-18" });
  sendMcp(2, "tools/list", {});
  await waitFor(() => responses.has(1) && responses.has(2));

  const toolNames = responses.get(2).result.tools.map((tool) => tool.name);
  assert.equal(toolNames[0], "start_browser_session");
  assert.ok(toolNames.includes("end_browser_session"));
  const browserTools = responses.get(2).result.tools.slice(1);
  for (const tool of browserTools) {
    assert.deepEqual(tool.inputSchema.properties.browser.enum, ["chrome", "edge"]);
    assert.ok(tool.inputSchema.required.includes("sessionId"));
  }

  const sessionA = await startSession(3);
  const sessionB = await startSession(4);
  assert.notEqual(sessionA, sessionB);

  sendTool(5, "list_browser_tabs", { sessionId: sessionA });
  await waitFor(() => responses.has(5));
  assert.match(responses.get(5).result.content[0].text, /No browser is connected/);

  const chrome = await startHost("chrome");
  const edge = await startHost("edge");

  sendTool(6, "open_browser_tab", {
    sessionId: sessionA,
    browser: "chrome",
    url: "https://example.com"
  });
  const openA = await nextBrowserRequest(chrome, "open_tab", 0);
  assert.equal(openA.args.sessionId, sessionA);
  respond(chrome, openA, { id: 42, title: "Conversation A" });
  await waitFor(() => responses.has(6));

  sendTool(7, "open_browser_tab", {
    sessionId: sessionB,
    browser: "edge",
    url: "https://example.org"
  });
  const openB = await nextBrowserRequest(edge, "open_tab", 0);
  assert.equal(openB.args.sessionId, sessionB);
  respond(edge, openB, { id: 84, title: "Conversation B" });
  await waitFor(() => responses.has(7));

  sendTool(8, "list_browser_tabs", { sessionId: sessionA, browser: "chrome" });
  const listA = await nextBrowserRequest(chrome, "list_tabs", 0);
  respond(chrome, listA, [{
    id: 42,
    title: "Conversation A"
  }]);
  await waitFor(() => responses.has(8));
  assert.match(responses.get(8).result.content[0].text, /Conversation A/);

  sendTool(9, "list_browser_tabs", { sessionId: sessionB, browser: "chrome" });
  const listB = await nextBrowserRequest(chrome, "list_tabs", 1);
  respond(chrome, listB, [{
    id: 42,
    title: "Conversation A"
  }]);
  await waitFor(() => responses.has(9));
  assert.equal(responses.get(9).result.content[0].text, "[]");

  sendTool(10, "read_browser_tab", {
    sessionId: sessionB,
    browser: "chrome",
    tabId: 42
  });
  await waitFor(() => responses.has(10));
  assert.equal(responses.get(10).result.isError, true);
  assert.match(responses.get(10).result.content[0].text, /another Copilot conversation/);
  assert.equal(chrome.messages.filter((message) => message.method === "read_page").length, 0);

  sendTool(11, "type_in_browser_element", {
    sessionId: sessionA,
    browser: "chrome",
    tabId: 42,
    selector: "#first",
    text: "first"
  });
  sendTool(12, "type_in_browser_element", {
    sessionId: sessionA,
    browser: "chrome",
    tabId: 42,
    selector: "#second",
    text: "second"
  });
  const firstType = await nextBrowserRequest(chrome, "type", 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(chrome.messages.filter((message) => message.method === "type").length, 1);
  respond(chrome, firstType, { typed: "#first" });
  const secondType = await nextBrowserRequest(chrome, "type", 1);
  respond(chrome, secondType, { typed: "#second" });
  await waitFor(() => responses.has(11) && responses.has(12));

  sendTool(13, "take_browser_screenshot", {
    sessionId: sessionA,
    browser: "chrome",
    tabId: 42
  });
  const screenshot = await nextBrowserRequest(chrome, "screenshot", 0);
  respond(chrome, screenshot, { data: "aW1hZ2U=", mimeType: "image/png", fullPage: false });
  await waitFor(() => responses.has(13));
  assert.deepEqual(responses.get(13).result.content[0], {
    type: "image",
    data: "aW1hZ2U=",
    mimeType: "image/png"
  });

  sendTool(14, "end_browser_session", { sessionId: sessionA });
  const endChrome = await nextBrowserRequest(chrome, "end_session", 0);
  const endEdge = await nextBrowserRequest(edge, "end_session", 0);
  assert.equal(endChrome.args.sessionId, sessionA);
  assert.equal(endEdge.args.sessionId, sessionA);
  respond(chrome, endChrome, { detachedTabs: 1 });
  respond(edge, endEdge, { detachedTabs: 0 });
  await waitFor(() => responses.has(14));

  sendTool(15, "list_browser_tabs", { sessionId: sessionA, browser: "chrome" });
  await waitFor(() => responses.has(15));
  assert.match(responses.get(15).result.content[0].text, /Unknown browser session/);

  const mcp2 = spawn(process.execPath, [path.join(root, "src/mcp.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env
  });
  const responses2 = new Map();
  mcp2.stdout.on("data", createLineDecoder((message) => responses2.set(message.id, message)));
  writeLine(mcp2.stdin, {
    jsonrpc: "2.0",
    id: 101,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  writeLine(mcp2.stdin, {
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: { name: "start_browser_session", arguments: {} }
  });
  await waitFor(() => responses2.has(101) && responses2.has(102));
  assert.notEqual(JSON.parse(responses2.get(102).result.content[0].text).sessionId, sessionB);
  mcp2.stdin.end();
  await new Promise((resolve) => mcp2.once("exit", resolve));

  for (const { host } of hosts) host.stdin.end();
  await Promise.all(hosts.map(({ host }) => new Promise((resolve) => host.once("exit", resolve))));
  mcp.stdin.end();
  await new Promise((resolve) => mcp.once("exit", resolve));
  daemon.kill("SIGTERM");
  await new Promise((resolve) => daemon.once("exit", resolve));

  function sendMcp(id, method, params) {
    writeLine(mcp.stdin, { jsonrpc: "2.0", id, method, params });
  }

  function sendTool(id, name, arguments_) {
    sendMcp(id, "tools/call", { name, arguments: arguments_ });
  }

  async function startSession(id) {
    sendTool(id, "start_browser_session", {});
    await waitFor(() => responses.has(id));
    return JSON.parse(responses.get(id).result.content[0].text).sessionId;
  }

  async function startHost(browser) {
    const host = spawn(process.execPath, [path.join(root, "src/native-host.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });
    const messages = [];
    hosts.push({ host, messages });
    host.stdout.on("data", createNativeDecoder((message) => messages.push(message)));
    await waitFor(() => messages.some((message) => message.event === "bridge_status" && message.connected));
    host.stdin.write(encodeNative({ event: "browser_hello", browser }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { host, messages };
  }
});

async function nextBrowserRequest(host, method, index) {
  await waitFor(() => host.messages.filter((message) => message.method === method).length > index);
  return host.messages.filter((message) => message.method === method)[index];
}

function respond(host, request, result) {
  host.host.stdin.write(encodeNative({ id: request.id, result }));
}

async function waitFor(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for MCP responses");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
