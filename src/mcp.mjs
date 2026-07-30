#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLineDecoder, daemonAddress, writeLine } from "./protocol.mjs";

const VERSION = "0.8.2";
const daemonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

const tools = [
  {
    name: "start_browser_session",
    description: "Start an isolated browser session for this conversation. Call once before any other browser tool and reuse the returned sessionId for every later call.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "list_browser_tabs",
    description: "List only tabs opened by this Copilot bridge, optionally in Chrome or Edge. User-owned tabs are never returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "open_browser_tab",
    description: "Open an HTTP(S) tab in the requested real Chrome or Edge profile and add it to the VSC Copilot Mngd group.",
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
  },
  {
    name: "end_browser_session",
    description: "Finish browser work by detaching debugger sessions and clearing transient console/dialog state. Managed tabs remain open and approved.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

const browserProperty = {
  type: "string",
  enum: ["chrome", "edge"],
  description: "Target browser. Required when both Chrome and Edge are connected unless tab ownership is already known."
};
for (const tool of tools) {
  if (tool.name !== "start_browser_session") {
    tool.inputSchema.properties.browser = browserProperty;
    tool.inputSchema.properties.sessionId = {
      type: "string",
      description: "Session ID returned by start_browser_session in this conversation."
    };
    tool.inputSchema.required = [...new Set([...(tool.inputSchema.required ?? []), "sessionId"])];
  }
}

const pending = new Map();
let daemonSocket;

function attachDaemonSocket(socket) {
  daemonSocket = socket;
  socket.on("data", createLineDecoder((message) => {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }));
  socket.once("close", () => {
    if (daemonSocket === socket) daemonSocket = undefined;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error("Persistent browser daemon disconnected"));
      pending.delete(id);
    }
  });
}

function requestDaemon(method, params = {}) {
  if (!daemonSocket || daemonSocket.destroyed) {
    return Promise.reject(new Error("Persistent browser daemon is not connected"));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Persistent browser daemon timed out"));
    }, 40000);
    pending.set(id, { resolve, reject, timer });
    writeLine(daemonSocket, { id, method, params });
  });
}

async function ensureDaemon() {
  let socket = await tryConnectDaemon();
  if (!socket) {
    spawnDaemon();
    socket = await waitForDaemon();
  }
  attachDaemonSocket(socket);

  const info = await requestDaemon("info");
  if (info.version === VERSION) return;

  await requestDaemon("shutdown");
  daemonSocket?.destroy();
  daemonSocket = undefined;
  spawnDaemon();
  attachDaemonSocket(await waitForDaemon());
  const restarted = await requestDaemon("info");
  if (restarted.version !== VERSION) {
    throw new Error(`Persistent daemon version mismatch: expected ${VERSION}, got ${restarted.version}`);
  }
}

function tryConnectDaemon() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(daemonAddress());
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
      else reject(error);
    });
  });
}

async function waitForDaemon() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const socket = await tryConnectDaemon();
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Persistent browser daemon did not start");
}

function spawnDaemon() {
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env
  });
  child.unref();
}

function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  if (name === "start_browser_session") return;
  if (args.browser !== undefined && !["chrome", "edge"].includes(args.browser)) {
    throw new Error("browser must be chrome or edge");
  }
  requireString(args.sessionId, "sessionId");
  if (name === "list_browser_tabs") return;
  if (name === "end_browser_session") return;
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
  if (name === "start_browser_session") return requestDaemon("start_session");
  return requestDaemon("call", {
    sessionId: args.sessionId,
    name,
    arguments: args
  });
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
          serverInfo: { name: "copilot-browser-interaction", version: VERSION },
          instructions: "Use this server for real-browser and E2E work. FIRST call start_browser_session once per conversation and reuse its sessionId in every later browser tool call. Never reuse or reveal a sessionId from another conversation. Browser connections persist through a per-user daemon shared across VS Code. When the user names Chrome or Edge, pass that browser explicitly. Open a Copilot-owned tab first; user-owned tabs are inaccessible until explicitly shared. Page access follows the extension's approval settings. After finishing, call end_browser_session once without a browser to detach every browser used by this conversation and invalidate its sessionId, unless the user asks to keep debugging attached."
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

try {
  await ensureDaemon();
  process.stdin.on("data", createLineDecoder((message) => void handleMessage(message)));
  process.stdin.on("end", () => daemonSocket?.destroy());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
