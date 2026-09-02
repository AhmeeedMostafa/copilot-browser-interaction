#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bridgeAddress, createLineDecoder, daemonAddress, writeLine } from "./protocol.mjs";

const VERSION = "0.9.2";
const browserMethods = {
  list_browser_tabs: "list_tabs",
  open_browser_tab: "open_tab",
  close_browser_tab: "close_tab",
  navigate_browser_tab: "navigate_tab",
  browser_tab_history: "history",
  read_browser_tab: "read_page",
  take_browser_screenshot: "screenshot",
  click_browser_element: "click",
  type_in_browser_element: "type",
  press_browser_key: "press_key",
  hover_browser_element: "hover",
  drag_browser_element: "drag",
  select_browser_option: "select",
  scroll_browser_tab: "scroll",
  wait_for_browser: "wait_for",
  handle_browser_dialog: "handle_dialog",
  highlight_browser_text: "highlight_text",
  read_browser_console: "console",
  resize_browser_viewport: "resize",
  batch_browser_actions: "batch",
  end_browser_session: "end_session"
};

const browsers = new Map();
const browserQueues = new Map();
const socketBrowsers = new WeakMap();
const tabSessions = new Map();
const pendingBrowserCalls = new Map();
const clients = new Set();
const sessions = new Set();
let shuttingDown = false;

const browserServer = net.createServer((socket) => {
  socket.on("data", createLineDecoder((message) => {
    if (message.event === "browser_hello") {
      registerBrowser(socket, message.browser);
      return;
    }

    const request = pendingBrowserCalls.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pendingBrowserCalls.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  }));

  socket.once("close", () => {
    const browser = socketBrowsers.get(socket);
    if (browser && browsers.get(browser) === socket) browsers.delete(browser);
    for (const [id, request] of pendingBrowserCalls) {
      if (request.socket !== socket) continue;
      clearTimeout(request.timer);
      request.reject(new Error("Browser extension disconnected"));
      pendingBrowserCalls.delete(id);
    }
  });
});

const clientServer = net.createServer((socket) => {
  clients.add(socket);
  socket.on("data", createLineDecoder((message) => void handleClientMessage(socket, message)));
  socket.once("close", () => clients.delete(socket));
});

function registerBrowser(socket, browser) {
  if (!["chrome", "edge"].includes(browser)) {
    socket.destroy(new Error(`Unsupported browser identity: ${browser}`));
    return;
  }

  const previous = browsers.get(browser);
  if (previous && previous !== socket) previous.destroy();
  browsers.set(browser, socket);
  socketBrowsers.set(socket, browser);
}

async function handleClientMessage(socket, message) {
  if (message.id === undefined) return;

  try {
    let result;
    if (message.method === "info") {
      result = { version: VERSION, browsers: [...browsers.keys()] };
    } else if (message.method === "start_session") {
      const sessionId = randomUUID();
      sessions.add(sessionId);
      result = { sessionId };
    } else if (message.method === "call") {
      const sessionId = message.params?.sessionId;
      requireSession(sessionId);
      result = await executeTool(message.params?.name, message.params?.arguments ?? {}, sessionId);
      if (message.params?.name === "end_browser_session" && !message.params?.arguments?.browser) {
        sessions.delete(sessionId);
      }
    } else if (message.method === "shutdown") {
      result = { shuttingDown: true };
      writeLine(socket, { id: message.id, result });
      await shutdown();
      return;
    } else {
      throw new Error(`Unknown daemon method: ${message.method}`);
    }
    writeLine(socket, { id: message.id, result });
  } catch (error) {
    writeLine(socket, { id: message.id, error: { message: error.message } });
  }
}

async function executeTool(name, args, clientId) {
  const method = browserMethods[name];
  if (!method) throw new Error(`Unknown browser tool: ${name}`);
  if (name === "list_browser_tabs") return listBrowserTabs(args.browser, clientId);
  if (name === "end_browser_session") return endBrowserSessions(args.browser, clientId);

  const browser = await selectBrowser(args, clientId);
  if (name !== "open_browser_tab") await requireOwnedTab(browser, args.tabId, clientId);
  const result = await callBrowser(browser, method, {
    ...args,
    sessionId: clientId
  });
  if (name === "open_browser_tab") {
    rememberTab(browser, result.id, clientId);
    return { ...result, browser };
  }
  if (name === "close_browser_tab") forgetOwnedTab(browser, args.tabId);
  return result;
}

async function listBrowserTabs(requestedBrowser, clientId) {
  const targets = requestedBrowser
    ? [requestedBrowser]
    : [...browsers.keys()];
  if (!targets.length) {
    throw new Error("No browser is connected. Start Chrome or Edge and enable Copilot browser interaction.");
  }

  const results = await Promise.all(targets.map(async (browser) => {
    connectedBrowser(browser);
    const tabs = await callBrowser(browser, "list_tabs", { sessionId: clientId });
    const visible = [];
    for (const tab of tabs) {
      const knownSession = tabSessions.get(tabKey(browser, tab.id));
      if (knownSession) {
        if (knownSession === clientId) visible.push(publicTab(tab, browser));
        continue;
      }

      if (tab.sessionId && tab.sessionId !== clientId) {
        rememberTab(browser, tab.id, tab.sessionId);
        continue;
      }

      let assigned = tab;
      if (!tab.sessionId) {
        assigned = {
          ...tab,
          ...await callBrowser(browser, "assign_tab", {
            tabId: tab.id,
            sessionId: clientId
          }),
          sessionId: clientId
        };
      }
      rememberTab(browser, assigned.id, clientId);
      visible.push(publicTab(assigned, browser));
    }
    return visible;
  }));
  return results.flat();
}

async function endBrowserSessions(requestedBrowser, clientId) {
  const targets = requestedBrowser ? [requestedBrowser] : [...browsers.keys()];
  if (!targets.length) return [];
  return Promise.all(targets.map(async (browser) => ({
    browser,
    ...await callBrowser(browser, "end_session", { sessionId: clientId })
  })));
}

async function selectBrowser(args, clientId) {
  if (args.browser) {
    connectedBrowser(args.browser);
    return args.browser;
  }

  if (Number.isInteger(args.tabId)) {
    let owners = ownedBrowsers(args.tabId, clientId);
    if (!owners.length) {
      await Promise.all([...browsers.keys()].map(refreshBrowserTabs));
      owners = ownedBrowsers(args.tabId, clientId);
    }
    if (owners.length === 1) return owners[0];
    if (owners.length > 1) throw new Error("This tab ID exists in multiple browsers; specify browser.");
  }

  if (browsers.size === 1) return browsers.keys().next().value;
  if (!browsers.size) {
    throw new Error("No browser is connected. Start Chrome or Edge and enable Copilot browser interaction.");
  }
  throw new Error("Chrome and Edge are both connected; specify browser.");
}

function connectedBrowser(browser) {
  const socket = browsers.get(browser);
  if (!socket || socket.destroyed) throw new Error(`${browserName(browser)} is not connected.`);
  return socket;
}

function callBrowser(browser, method, args) {
  const previous = browserQueues.get(browser) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => sendBrowserCommand(browser, method, args));
  browserQueues.set(browser, operation);
  operation.finally(() => {
    if (browserQueues.get(browser) === operation) browserQueues.delete(browser);
  }).catch(() => {});
  return operation;
}

function sendBrowserCommand(browser, method, args) {
  const socket = connectedBrowser(browser);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserCalls.delete(id);
      reject(new Error("Browser command timed out"));
    }, 35000);
    pendingBrowserCalls.set(id, { resolve, reject, timer, socket });
    writeLine(socket, { id, method, args: withoutBrowser(args) });
  });
}

async function requireOwnedTab(browser, tabId, clientId) {
  const key = tabKey(browser, tabId);
  if (!tabSessions.has(key)) await refreshBrowserTabs(browser);
  if (tabSessions.get(key) !== clientId) {
    throw new Error("This managed tab belongs to another Copilot conversation");
  }
}

function forgetOwnedTab(browser, tabId) {
  tabSessions.delete(tabKey(browser, tabId));
}

async function refreshBrowserTabs(browser) {
  const tabs = await callBrowser(browser, "list_tabs", {});
  const current = new Set();
  for (const tab of tabs) {
    current.add(tabKey(browser, tab.id));
    if (tab.sessionId) rememberTab(browser, tab.id, tab.sessionId);
  }
  for (const key of tabSessions.keys()) {
    if (key.startsWith(`${browser}:`) && !current.has(key)) tabSessions.delete(key);
  }
}

function rememberTab(browser, tabId, clientId) {
  tabSessions.set(tabKey(browser, tabId), clientId);
}

function ownedBrowsers(tabId, clientId) {
  return [...browsers.keys()].filter(
    (browser) => tabSessions.get(tabKey(browser, tabId)) === clientId
  );
}

function tabKey(browser, tabId) {
  return `${browser}:${tabId}`;
}

function publicTab(tab, browser) {
  const { source: _source, sessionId: _sessionId, ...visible } = tab;
  return { ...visible, browser };
}

function browserName(browser) {
  return browser === "edge" ? "Microsoft Edge" : "Google Chrome";
}

function withoutBrowser(args) {
  const { browser: _browser, ...rest } = args;
  return rest;
}

function requireSession(value) {
  if (typeof value !== "string" || !sessions.has(value)) {
    throw new Error("Unknown browser session. Call start_browser_session in this conversation.");
  }
}

async function listen(server, address) {
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(address), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(address), 0o700);
    await removeStaleSocket(address);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(address, 0o600);
}

async function removeStaleSocket(address) {
  if (!fs.existsSync(address)) return;
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(address);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(`Socket already in use: ${address}`));
    });
    probe.once("error", (error) => {
      if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT") {
        reject(error);
        return;
      }
      fs.rmSync(address);
      resolve();
    });
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of clients) socket.destroy();
  for (const socket of browsers.values()) socket.destroy();
  await Promise.all([
    new Promise((resolve) => clientServer.close(resolve)),
    new Promise((resolve) => browserServer.close(resolve))
  ]);
  if (process.platform !== "win32") {
    fs.rmSync(daemonAddress(), { force: true });
    fs.rmSync(bridgeAddress(), { force: true });
  }
  process.exit(0);
}

try {
  await listen(browserServer, bridgeAddress());
  await listen(clientServer, daemonAddress());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
