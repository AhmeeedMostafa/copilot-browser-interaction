#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bridgeAddress, createLineDecoder, writeLine } from "./protocol.mjs";

const tools = [
  {
    name: "list_browser_tabs",
    description: "List only tabs opened by this Copilot bridge. User-owned tabs are never returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "open_browser_tab",
    description: "Open an HTTP(S) tab in the real Chrome or Edge profile and add it to the VSC Copilot Mngd group.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        active: { type: "boolean", default: true }
      },
      required: ["url"],
      additionalProperties: false
    },
    annotations: { openWorldHint: true }
  },
  {
    name: "close_browser_tab",
    description: "Close a Copilot-owned tab. User-owned tabs are rejected.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      required: ["tabId"],
      additionalProperties: false
    },
    annotations: { destructiveHint: true }
  },
  {
    name: "navigate_browser_tab",
    description: "Navigate a Copilot-owned tab to an HTTP(S) URL.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        url: { type: "string", format: "uri" }
      },
      required: ["tabId", "url"],
      additionalProperties: false
    },
    annotations: { openWorldHint: true }
  },
  {
    name: "browser_tab_history",
    description: "Go back, go forward, or reload a Copilot-owned tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        action: { type: "string", enum: ["back", "forward", "reload"] }
      },
      required: ["tabId", "action"],
      additionalProperties: false
    }
  },
  {
    name: "read_browser_tab",
    description: "Read page text and interactive element selectors from an approved Copilot-owned tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 }
      },
      required: ["tabId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "take_browser_screenshot",
    description: "Capture the viewport or full page of an approved Copilot-owned tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        fullPage: { type: "boolean", default: false },
        format: { type: "string", enum: ["png", "jpeg"], default: "png" },
        quality: { type: "integer", minimum: 1, maximum: 100, default: 80 }
      },
      required: ["tabId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "click_browser_element",
    description: "Click an element using browser input events. Use a selector returned by read_browser_tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        selector: { type: "string", minLength: 1 },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        doubleClick: { type: "boolean", default: false }
      },
      required: ["tabId", "selector"],
      additionalProperties: false
    }
  },
  {
    name: "type_in_browser_element",
    description: "Type into an input, textarea, or contenteditable element using browser input events.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        selector: { type: "string", minLength: 1 },
        text: { type: "string" },
        replace: { type: "boolean", default: true }
      },
      required: ["tabId", "selector", "text"],
      additionalProperties: false
    }
  },
  {
    name: "press_browser_key",
    description: "Press a key in an approved Copilot-owned tab, optionally with modifier keys.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        key: { type: "string", minLength: 1 },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
          default: []
        }
      },
      required: ["tabId", "key"],
      additionalProperties: false
    }
  },
  {
    name: "hover_browser_element",
    description: "Move the browser pointer over an element.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        selector: { type: "string", minLength: 1 }
      },
      required: ["tabId", "selector"],
      additionalProperties: false
    }
  },
  {
    name: "drag_browser_element",
    description: "Drag one element onto another using browser mouse events.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        fromSelector: { type: "string", minLength: 1 },
        toSelector: { type: "string", minLength: 1 }
      },
      required: ["tabId", "fromSelector", "toSelector"],
      additionalProperties: false
    }
  },
  {
    name: "select_browser_option",
    description: "Select one or more values in a select element.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        selector: { type: "string", minLength: 1 },
        values: { type: "array", minItems: 1, items: { type: "string" } }
      },
      required: ["tabId", "selector", "values"],
      additionalProperties: false
    }
  },
  {
    name: "scroll_browser_tab",
    description: "Scroll by an offset or bring an element into view.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        x: { type: "number", default: 0 },
        y: { type: "number", default: 0 },
        selector: { type: "string", minLength: 1 }
      },
      required: ["tabId"],
      additionalProperties: false
    }
  },
  {
    name: "wait_for_browser",
    description: "Wait for text to appear or disappear, or for an element state, in an approved tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        text: { type: "string", minLength: 1 },
        textGone: { type: "string", minLength: 1 },
        selector: { type: "string", minLength: 1 },
        state: { type: "string", enum: ["visible", "hidden", "attached", "detached"], default: "visible" },
        timeout: { type: "integer", minimum: 0, maximum: 30000, default: 10000 }
      },
      required: ["tabId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "handle_browser_dialog",
    description: "Accept or dismiss an open JavaScript alert, confirm, or prompt dialog.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        accept: { type: "boolean" },
        promptText: { type: "string" }
      },
      required: ["tabId", "accept"],
      additionalProperties: false
    }
  },
  {
    name: "highlight_browser_text",
    description: "Select and scroll to the first exact text match on the page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        text: { type: "string", minLength: 1 }
      },
      required: ["tabId", "text"],
      additionalProperties: false
    }
  },
  {
    name: "read_browser_console",
    description: "Read recent console messages and page exceptions captured from an approved tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        level: { type: "string", enum: ["log", "debug", "info", "warning", "error"] },
        clear: { type: "boolean", default: false }
      },
      required: ["tabId"],
      additionalProperties: false
    }
  },
  {
    name: "resize_browser_viewport",
    description: "Emulate a viewport size in an approved Copilot-owned tab for responsive E2E testing.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        width: { type: "integer", minimum: 320, maximum: 7680 },
        height: { type: "integer", minimum: 240, maximum: 4320 },
        deviceScaleFactor: { type: "number", exclusiveMinimum: 0, maximum: 5, default: 1 }
      },
      required: ["tabId", "width", "height"],
      additionalProperties: false
    }
  }
];

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
  resize_browser_viewport: "resize"
};

let browser;
const pending = new Map();
const socketServer = net.createServer((socket) => {
  browser?.destroy();
  browser = socket;

  socket.on("data", createLineDecoder((message) => {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  }));

  socket.once("close", () => {
    if (browser === socket) browser = undefined;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error("Browser extension disconnected"));
      pending.delete(id);
    }
  });
});

async function startBridge() {
  const address = bridgeAddress();
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(address), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(address), 0o700);
    await removeStaleSocket(address);
  }

  await new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(address, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(address, 0o600);
}

async function removeStaleSocket(address) {
  if (!fs.existsSync(address)) return;

  await new Promise((resolve, reject) => {
    const probe = net.createConnection(address);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Another Copilot browser interaction MCP server is already running"));
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

function callBrowser(method, args) {
  if (!browser || browser.destroyed) {
    return Promise.reject(new Error("Browser extension is not connected. Start Chrome or Edge and enable Copilot browser interaction."));
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Browser command timed out"));
    }, 35000);
    pending.set(id, { resolve, reject, timer });
    writeLine(browser, { id, method, args });
  });
}

function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  if (name === "list_browser_tabs") return;
  if (name === "open_browser_tab") {
    requireString(args.url, "url");
    if (args.active !== undefined && typeof args.active !== "boolean") throw new Error("active must be a boolean");
    return;
  }

  requireTabId(args.tabId);
  switch (name) {
    case "close_browser_tab":
      return;
    case "navigate_browser_tab":
      requireString(args.url, "url");
      return;
    case "browser_tab_history":
      if (!["back", "forward", "reload"].includes(args.action)) throw new Error("Invalid history action");
      return;
    case "read_browser_tab":
      if (args.maxChars !== undefined && (!Number.isInteger(args.maxChars) || args.maxChars < 1000 || args.maxChars > 50000)) {
        throw new Error("maxChars must be an integer from 1000 to 50000");
      }
      return;
    case "take_browser_screenshot":
      if (args.fullPage !== undefined && typeof args.fullPage !== "boolean") throw new Error("fullPage must be a boolean");
      if (args.format !== undefined && !["png", "jpeg"].includes(args.format)) throw new Error("format must be png or jpeg");
      return;
    case "click_browser_element":
      requireSelector(args.selector);
      if (args.button !== undefined && !["left", "right", "middle"].includes(args.button)) throw new Error("Invalid mouse button");
      if (args.doubleClick !== undefined && typeof args.doubleClick !== "boolean") throw new Error("doubleClick must be a boolean");
      return;
    case "type_in_browser_element":
      requireSelector(args.selector);
      if (typeof args.text !== "string") throw new Error("text must be a string");
      if (args.replace !== undefined && typeof args.replace !== "boolean") throw new Error("replace must be a boolean");
      return;
    case "press_browser_key":
      requireString(args.key, "key");
      if (args.modifiers !== undefined && !Array.isArray(args.modifiers)) throw new Error("modifiers must be an array");
      return;
    case "hover_browser_element":
      requireSelector(args.selector);
      return;
    case "drag_browser_element":
      requireString(args.fromSelector, "fromSelector");
      requireString(args.toSelector, "toSelector");
      return;
    case "select_browser_option":
      requireSelector(args.selector);
      if (!Array.isArray(args.values) || !args.values.length || args.values.some((value) => typeof value !== "string")) {
        throw new Error("values must be a non-empty string array");
      }
      return;
    case "scroll_browser_tab":
      if (args.x !== undefined && !Number.isFinite(args.x)) throw new Error("x must be a number");
      if (args.y !== undefined && !Number.isFinite(args.y)) throw new Error("y must be a number");
      if (args.selector !== undefined) requireSelector(args.selector);
      return;
    case "wait_for_browser":
      if (!args.text && !args.textGone && !args.selector) throw new Error("text, textGone, or selector is required");
      return;
    case "handle_browser_dialog":
      if (typeof args.accept !== "boolean") throw new Error("accept must be a boolean");
      return;
    case "highlight_browser_text":
      requireString(args.text, "text");
      return;
    case "read_browser_console":
      if (args.clear !== undefined && typeof args.clear !== "boolean") throw new Error("clear must be a boolean");
      return;
    case "resize_browser_viewport":
      if (!Number.isInteger(args.width) || !Number.isInteger(args.height)) throw new Error("width and height must be integers");
      return;
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

function requireTabId(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
}

function requireSelector(value) {
  requireString(value, "selector");
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}

async function runTool(name, args) {
  validateArguments(name, args);
  const method = browserMethods[name];
  if (!method) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  return callBrowser(method, args);
}

function toolResult(name, value) {
  if (name === "take_browser_screenshot") {
    return {
      content: [
        { type: "image", data: value.data, mimeType: value.mimeType },
        { type: "text", text: value.fullPage ? "Captured full-page screenshot." : "Captured viewport screenshot." }
      ]
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function handleMessage(message) {
  if (message.id === undefined) return;

  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "copilot-browser-interaction", version: "0.2.0" },
          instructions: "Use this server for real-browser and E2E work. Open a Copilot-owned tab first; user-owned tabs are inaccessible. Page access follows the extension's per-site or per-tab approval setting."
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call": {
        const name = message.params?.name;
        result = toolResult(name, await runTool(name, message.params?.arguments ?? {}));
        break;
      }
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
    writeLine(process.stdout, { jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message.method === "tools/call" && !error.code) {
      writeLine(process.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: error.message }], isError: true }
      });
      return;
    }
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: error.code ?? -32603, message: error.message }
    });
  }
}

async function shutdown() {
  await new Promise((resolve) => socketServer.close(resolve));
  if (process.platform !== "win32") fs.rmSync(bridgeAddress(), { force: true });
}

try {
  await startBridge();
  process.stdin.on("data", createLineDecoder((message) => void handleMessage(message)));
  process.stdin.on("end", () => void shutdown());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
