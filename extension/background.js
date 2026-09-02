const HOST_NAME = "dev.copilot.open_tabs_bridge";
const GROUP_TITLE = "VSC Copilot Mngd";
const DEBUGGER_VERSION = "1.3";
// ponytail: keep in sync with the "action" enum in mcp.mjs's
// batch_browser_actions tool schema.
const BATCH_ACTIONS = new Set([
  "navigate_tab", "history", "read_page", "click", "type", "press_key",
  "hover", "drag", "select", "scroll", "wait_for", "handle_dialog", "highlight_text"
]);

let nativePort;
let mcpConnected = false;
const attachedTabs = new Set();
const consoleByTab = new Map();
const dialogByTab = new Map();

function connectNativeHost() {
  if (nativePort) return;

  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.postMessage(browserHello());
  nativePort.onMessage.addListener(async (message) => {
    if (message.event === "bridge_status") {
      mcpConnected = message.connected;
      if (message.connected) nativePort?.postMessage(browserHello());
      return;
    }
    if (!message.id || !message.method) return;

    try {
      const result = await runCommand(message.method, message.args ?? {});
      nativePort?.postMessage({ id: message.id, result });
    } catch (error) {
      nativePort?.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  nativePort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    nativePort = undefined;
    mcpConnected = false;
    setTimeout(connectNativeHost, 1000);
  });
}

function browserHello() {
  return {
    event: "browser_hello",
    browser: /\bEdg\//.test(navigator.userAgent) ? "edge" : "chrome"
  };
}

async function runCommand(method, args) {
  switch (method) {
    case "list_tabs": return listTabs();
    case "open_tab": return openTab(args);
    case "assign_tab": return assignTab(args);
    case "close_tab": return closeTab(args);
    case "navigate_tab": return navigateTab(args);
    case "history": return useHistory(args);
    case "read_page": return readPage(args);
    case "screenshot": return takeScreenshot(args);
    case "click": return clickElement(args);
    case "type": return typeInElement(args);
    case "press_key": return pressKey(args);
    case "hover": return hoverElement(args);
    case "drag": return dragElement(args);
    case "select": return selectOption(args);
    case "scroll": return scrollPage(args);
    case "wait_for": return waitForPage(args);
    case "handle_dialog": return handleDialog(args);
    case "highlight_text": return highlightText(args);
    case "console": return readConsole(args);
    case "resize": return resizeViewport(args);
    case "batch": return batchActions(args);
    case "end_session": return endBrowserSession(args);
    default: throw new Error(`Unknown browser command: ${method}`);
  }
}

async function batchActions({ tabId, actions, stopOnError = true }) {
  if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
  if (!Array.isArray(actions) || !actions.length) throw new Error("actions must be a non-empty array");
  if (typeof stopOnError !== "boolean") throw new Error("stopOnError must be a boolean");

  const results = [];
  for (const step of actions) {
    if (!step || typeof step !== "object" || !BATCH_ACTIONS.has(step.action)) {
      throw new Error(`Unsupported batch action: ${step?.action}`);
    }
    try {
      const result = await runCommand(step.action, { ...step.args, tabId });
      results.push({ action: step.action, ok: true, result });
    } catch (error) {
      results.push({ action: step.action, ok: false, error: error.message });
      if (stopOnError) break;
    }
  }
  return { results };
}

async function listTabs() {
  const stored = await chrome.storage.session.get(null);
  const entries = Object.entries(stored)
    .filter(([key]) => key.startsWith("agentTab:"))
    .map(([key, owner]) => ({
      id: Number(key.slice("agentTab:".length)),
      owner: String(owner)
    }));
  const tabs = await Promise.all(entries.map(async ({ id, owner }) => {
    try {
      const [source, sessionId] = owner.split(":");
      return {
        ...tabDetails(await chrome.tabs.get(id)),
        source,
        ...(sessionId ? { sessionId } : {})
      };
    } catch {
      await forgetTab(id);
      return undefined;
    }
  }));
  return tabs.filter(Boolean);
}

async function openTab({ url, active = true, sessionId }) {
  const target = webUrl(url);
  if (typeof active !== "boolean") throw new Error("active must be a boolean");
  requireSessionId(sessionId);

  const tab = await chrome.tabs.create({ url: target, active });
  try {
    await chrome.storage.session.set({ [`agentTab:${tab.id}`]: `copilot:${sessionId}` });
    await groupAgentTab(tab, sessionId);
    return tabDetails(await chrome.tabs.get(tab.id));
  } catch (error) {
    await chrome.tabs.remove(tab.id);
    throw error;
  }
}

async function assignTab({ tabId, sessionId }) {
  requireSessionId(sessionId);
  const { tab, owner } = await agentTab(tabId);
  const source = owner.startsWith("shared") ? "shared" : "copilot";
  await chrome.storage.session.set({ [`agentTab:${tabId}`]: `${source}:${sessionId}` });
  await groupAgentTab(tab, sessionId);
  return tabDetails(await chrome.tabs.get(tabId));
}

async function shareTab(tabId, approveTab) {
  if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error("Only HTTP(S) tabs can be shared");
  }

  await groupAgentTab(tab);
  await chrome.storage.session.set({
    [`agentTab:${tab.id}`]: "shared",
    ...(approveTab ? { [`approvedTab:${tab.id}`]: true } : {})
  });
  return tabDetails(await chrome.tabs.get(tab.id));
}

async function unshareTab(tabId) {
  const { tab } = await agentTab(tabId);
  await detachDebugger(tabId);
  await forgetTab(tabId);
  if (tab.groupId >= 0) await chrome.tabs.ungroup(tabId);
  return { unshared: tabId };
}

async function groupAgentTab(tab, sessionId) {
  const groupKey = sessionId ? `agentGroup:${tab.windowId}:${sessionId}` : undefined;
  let groupId = groupKey ? (await chrome.storage.session.get(groupKey))[groupKey] : undefined;
  if (groupId !== undefined) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      await chrome.storage.session.remove(groupKey);
      groupId = undefined;
    }
  }

  groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    ...(groupId === undefined ? {} : { groupId })
  });
  if (groupKey) await chrome.storage.session.set({ [groupKey]: groupId });
  await chrome.tabGroups.update(groupId, {
    title: GROUP_TITLE,
    color: "blue",
    collapsed: false
  });
}

async function closeTab({ tabId }) {
  await agentTab(tabId);
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function navigateTab({ tabId, url }) {
  await agentTab(tabId);
  if (await approvalMode() === "site") await detachDebugger(tabId);
  const tab = await chrome.tabs.update(tabId, { url: webUrl(url) });
  return tabDetails(tab);
}

async function useHistory({ tabId, action }) {
  await agentTab(tabId);
  if (!["back", "forward", "reload"].includes(action)) {
    throw new Error("action must be back, forward, or reload");
  }
  if (await approvalMode() === "site") await detachDebugger(tabId);
  if (action === "back") await chrome.tabs.goBack(tabId);
  else if (action === "forward") await chrome.tabs.goForward(tabId);
  else await chrome.tabs.reload(tabId);
  return { tabId, action };
}

async function agentTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
  const key = `agentTab:${tabId}`;
  const owner = (await chrome.storage.session.get(key))[key];
  if (!owner) {
    throw new Error("This tab was not opened by Copilot");
  }

  try {
    return { tab: await chrome.tabs.get(tabId), owner };
  } catch (error) {
    await forgetTab(tabId);
    throw error;
  }
}

async function approvedTab(tabId) {
  const { tab, owner } = await agentTab(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error("Only HTTP(S) tabs are supported");
  }

  // ponytail: approvalMode/autoApproveCopilotTabs are read-mostly popup
  // settings, cached in memory and kept correct via storage.onChanged so
  // every action avoids 2-3 redundant chrome.storage IPC round-trips.
  const { autoApproveCopilotTabs = false } = await getSettings();
  if (owner.startsWith("copilot") && autoApproveCopilotTabs) {
    await ensureDebugger(tabId);
    return tab;
  }

  const mode = await approvalMode();
  if (mode === "tab") {
    const key = `approvedTab:${tabId}`;
    if (!(await chrome.storage.session.get(key))[key]) {
      throw new Error("This Copilot tab is not approved. Open the extension popup on this tab and choose Allow this tab.");
    }
  } else {
    const origin = originPattern(tab.url);
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      throw new Error(`Site access is not granted for ${new URL(tab.url).hostname}. Open the extension popup on this tab and choose Allow this site.`);
    }
  }

  await ensureDebugger(tabId);
  return tab;
}

let settingsCache;

async function getSettings() {
  if (!settingsCache) {
    settingsCache = await chrome.storage.local.get(["approvalMode", "autoApproveCopilotTabs"]);
  }
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !settingsCache) return;
  for (const key of ["approvalMode", "autoApproveCopilotTabs"]) {
    if (key in changes) settingsCache[key] = changes[key].newValue;
  }
});

async function approvalMode() {
  const { approvalMode = "site" } = await getSettings();
  return approvalMode === "tab" ? "tab" : "site";
}

async function ensureDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;

  const target = { tabId };
  await chrome.debugger.attach(target, DEBUGGER_VERSION);
  attachedTabs.add(tabId);
  try {
    // ponytail: independent CDP domains, no need to enable one at a time
    await Promise.all([
      chrome.debugger.sendCommand(target, "Page.enable"),
      chrome.debugger.sendCommand(target, "Runtime.enable"),
      chrome.debugger.sendCommand(target, "Log.enable")
    ]);
  } catch (error) {
    attachedTabs.delete(tabId);
    await chrome.debugger.detach(target);
    throw error;
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.delete(tabId)) return;
  await chrome.debugger.detach({ tabId });
}

async function detachAllDebuggers() {
  const tabIds = [...attachedTabs];
  await Promise.all(tabIds.map(detachDebugger));
  return tabIds.length;
}

async function endBrowserSession({ sessionId }) {
  requireSessionId(sessionId);
  const stored = await chrome.storage.session.get(null);
  const tabIds = [...attachedTabs].filter((tabId) => {
    const owner = stored[`agentTab:${tabId}`];
    return typeof owner === "string" && owner.endsWith(`:${sessionId}`);
  });
  await Promise.all(tabIds.map(detachDebugger));
  for (const tabId of tabIds) {
    consoleByTab.delete(tabId);
    dialogByTab.delete(tabId);
  }
  return { detachedTabs: tabIds.length };
}

function sendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, expression) {
  const response = await sendCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

function evaluateFunction(tabId, func, args = []) {
  const serialized = args.map((arg) => JSON.stringify(arg)).join(",");
  return evaluate(tabId, `(${func})(${serialized})`);
}

async function readPage({ tabId, maxChars = 20000 }) {
  await approvedTab(tabId);
  const limit = Number.isInteger(maxChars) ? Math.min(Math.max(maxChars, 1000), 50000) : 20000;
  return evaluateFunction(tabId, collectPage, [limit]);
}

function collectPage(maxChars) {
  function selectorFor(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;

    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((item) => item.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }

  const interactive = [...document.querySelectorAll(
    "a[href],button,input,textarea,select,[role='button'],[contenteditable='true']"
  )]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    })
    .slice(0, 150)
    .map((element) => {
      const type = element.getAttribute("type");
      const rect = element.getBoundingClientRect();
      return {
        selector: selectorFor(element),
        tag: element.localName,
        type,
        text: type === "password" ? "" : (element.innerText || element.value || "").trim().slice(0, 200),
        ariaLabel: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
        disabled: Boolean(element.disabled),
        checked: "checked" in element ? Boolean(element.checked) : undefined,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });

  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? "").slice(0, maxChars),
    interactive
  };
}

async function takeScreenshot({ tabId, fullPage = false, format = "png", quality = 80 }) {
  await approvedTab(tabId);
  if (!["png", "jpeg"].includes(format)) throw new Error("format must be png or jpeg");
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error("quality must be an integer from 1 to 100");
  }

  const metrics = fullPage ? await sendCommand(tabId, "Page.getLayoutMetrics") : undefined;
  const contentSize = metrics?.cssContentSize ?? metrics?.contentSize;
  const result = await sendCommand(tabId, "Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality } : {}),
    ...(contentSize ? {
      clip: {
        x: 0,
        y: 0,
        width: contentSize.width,
        height: contentSize.height,
        scale: 1
      }
    } : {}),
    captureBeyondViewport: Boolean(fullPage),
    fromSurface: true
  });
  if (result.data.length > 60 * 1024 * 1024) {
    throw new Error("Screenshot exceeds the native messaging limit. Use JPEG or capture only the viewport.");
  }
  return { data: result.data, mimeType: `image/${format}`, fullPage: Boolean(fullPage) };
}

async function elementPoint(tabId, selector) {
  return evaluateFunction(tabId, (target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`Element not found: ${target}`);
    if (element.disabled) throw new Error(`Element is disabled: ${target}`);
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error(`Element is not visible: ${target}`);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, [selector]);
}

async function clickElement({ tabId, selector, button = "left", doubleClick = false }) {
  if (!["left", "right", "middle"].includes(button)) throw new Error("button must be left, right, or middle");
  await approvedTab(tabId);
  const point = await elementPoint(tabId, requiredSelector(selector));
  const clickCount = doubleClick ? 2 : 1;
  for (let count = 1; count <= clickCount; count++) {
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount: count });
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount: count });
  }
  return { clicked: selector, button, clickCount };
}

async function typeInElement({ tabId, selector, text, replace = true }) {
  if (typeof text !== "string") throw new Error("text must be a string");
  if (typeof replace !== "boolean") throw new Error("replace must be a boolean");
  await approvedTab(tabId);
  await evaluateFunction(tabId, (target, shouldReplace) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`Element not found: ${target}`);
    if (element.disabled || element.readOnly) throw new Error(`Element is not editable: ${target}`);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
      throw new Error(`Element is not editable: ${target}`);
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    if (!shouldReplace) return;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [requiredSelector(selector), replace]);
  await sendCommand(tabId, "Input.insertText", { text });
  return { typed: selector, length: text.length, replaced: replace };
}

async function pressKey({ tabId, key, modifiers = [] }) {
  if (typeof key !== "string" || !key) throw new Error("key is required");
  if (!Array.isArray(modifiers) || modifiers.some((item) => !["Alt", "Control", "Meta", "Shift"].includes(item))) {
    throw new Error("modifiers may contain Alt, Control, Meta, and Shift");
  }
  await approvedTab(tabId);
  const mask = modifiers.reduce((value, modifier) => value | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 })[modifier], 0);
  const definition = keyDefinition(key);
  await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: mask, ...definition });
  await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: mask, ...definition });
  return { key, modifiers };
}

function keyDefinition(key) {
  const known = {
    Enter: ["Enter", 13],
    Tab: ["Tab", 9],
    Escape: ["Escape", 27],
    Backspace: ["Backspace", 8],
    Delete: ["Delete", 46],
    ArrowLeft: ["ArrowLeft", 37],
    ArrowUp: ["ArrowUp", 38],
    ArrowRight: ["ArrowRight", 39],
    ArrowDown: ["ArrowDown", 40],
    Home: ["Home", 36],
    End: ["End", 35],
    PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34],
    Space: ["Space", 32]
  };
  if (known[key]) {
    const [code, windowsVirtualKeyCode] = known[key];
    return { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode };
  }
  if (key.length === 1) {
    return {
      key,
      text: key,
      code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "",
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0)
    };
  }
  throw new Error(`Unsupported key: ${key}`);
}

async function hoverElement({ tabId, selector }) {
  await approvedTab(tabId);
  const point = await elementPoint(tabId, requiredSelector(selector));
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  return { hovered: selector };
}

async function dragElement({ tabId, fromSelector, toSelector }) {
  await approvedTab(tabId);
  const from = await elementPoint(tabId, requiredSelector(fromSelector));
  const to = await elementPoint(tabId, requiredSelector(toSelector));
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...to, button: "left", buttons: 1 });
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
  return { dragged: fromSelector, to: toSelector };
}

async function selectOption({ tabId, selector, values }) {
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== "string")) {
    throw new Error("values must be a non-empty string array");
  }
  await approvedTab(tabId);
  return evaluateFunction(tabId, (target, selectedValues) => {
    const element = document.querySelector(target);
    if (!(element instanceof HTMLSelectElement)) throw new Error(`Element is not a select: ${target}`);
    if (!element.multiple && selectedValues.length > 1) throw new Error("This select accepts only one value");
    for (const option of element.options) option.selected = selectedValues.includes(option.value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: [...element.selectedOptions].map((option) => option.value) };
  }, [requiredSelector(selector), values]);
}

async function scrollPage({ tabId, x = 0, y = 0, selector }) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers");
  await approvedTab(tabId);
  return evaluateFunction(tabId, (left, top, target) => {
    if (target) {
      const element = document.querySelector(target);
      if (!element) throw new Error(`Element not found: ${target}`);
      element.scrollIntoView({ block: "center", inline: "center" });
    } else {
      window.scrollBy({ left, top, behavior: "instant" });
    }
    return { x: window.scrollX, y: window.scrollY };
  }, [x, y, selector ? requiredSelector(selector) : null]);
}

async function waitForPage({ tabId, text, textGone, selector, state = "visible", timeout = 10000 }) {
  if (!text && !textGone && !selector) throw new Error("text, textGone, or selector is required");
  if (!["visible", "hidden", "attached", "detached"].includes(state)) {
    throw new Error("state must be visible, hidden, attached, or detached");
  }
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30000) {
    throw new Error("timeout must be an integer from 0 to 30000");
  }
  await approvedTab(tabId);

  const deadline = Date.now() + timeout;
  do {
    const matched = await evaluateFunction(tabId, (expected, gone, target, targetState) => {
      const bodyText = document.body?.innerText ?? "";
      if (expected && !bodyText.includes(expected)) return false;
      if (gone && bodyText.includes(gone)) return false;
      if (!target) return true;
      const element = document.querySelector(target);
      if (targetState === "attached") return Boolean(element);
      if (targetState === "detached") return !element;
      const visible = Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height);
      return targetState === "visible" ? visible : !visible;
    }, [text ?? null, textGone ?? null, selector ?? null, state]);
    if (matched) return { matched: true };
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() <= deadline);

  throw new Error("Timed out waiting for the page condition");
}

async function handleDialog({ tabId, accept, promptText }) {
  if (typeof accept !== "boolean") throw new Error("accept must be a boolean");
  await approvedTab(tabId);
  if (!dialogByTab.has(tabId)) throw new Error("No JavaScript dialog is open");
  await sendCommand(tabId, "Page.handleJavaScriptDialog", {
    accept,
    ...(promptText === undefined ? {} : { promptText: String(promptText) })
  });
  dialogByTab.delete(tabId);
  return { accepted: accept };
}

async function highlightText({ tabId, text }) {
  if (typeof text !== "string" || !text) throw new Error("text is required");
  await approvedTab(tabId);
  return evaluateFunction(tabId, (needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const index = walker.currentNode.data.indexOf(needle);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(walker.currentNode, index);
      range.setEnd(walker.currentNode, index + needle.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      walker.currentNode.parentElement?.scrollIntoView({ block: "center" });
      return { highlighted: needle };
    }
    throw new Error("Text not found");
  }, [text]);
}

async function readConsole({ tabId, level, clear = false }) {
  if (level !== undefined && !["log", "debug", "info", "warning", "error"].includes(level)) {
    throw new Error("Unsupported console level");
  }
  if (typeof clear !== "boolean") throw new Error("clear must be a boolean");
  await approvedTab(tabId);
  const messages = (consoleByTab.get(tabId) ?? []).filter((entry) => !level || entry.level === level);
  if (clear) consoleByTab.set(tabId, []);
  return messages;
}

async function resizeViewport({ tabId, width, height, deviceScaleFactor = 1 }) {
  if (!Number.isInteger(width) || width < 320 || width > 7680) throw new Error("width must be from 320 to 7680");
  if (!Number.isInteger(height) || height < 240 || height > 4320) throw new Error("height must be from 240 to 4320");
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0 || deviceScaleFactor > 5) {
    throw new Error("deviceScaleFactor must be greater than 0 and at most 5");
  }
  await approvedTab(tabId);
  await sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile: false
  });
  return { width, height, deviceScaleFactor };
}

function appendConsole(tabId, entry) {
  const messages = consoleByTab.get(tabId) ?? [];
  messages.push({ timestamp: new Date().toISOString(), ...entry });
  consoleByTab.set(tabId, messages.slice(-200));
}

function requiredSelector(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("selector is required");
  return value;
}

function requireSessionId(value) {
  if (typeof value !== "string" || !value) throw new Error("sessionId is required");
}

function webUrl(value) {
  if (typeof value !== "string") throw new Error("url must be a string");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are supported");
  }
  return parsed.href;
}

function tabDetails({ id, windowId, groupId, active, status, title, url }) {
  return { id, windowId, groupId, active, status, title, url };
}

async function forgetTab(tabId) {
  await chrome.storage.session.remove([`agentTab:${tabId}`, `approvedTab:${tabId}`]);
  attachedTabs.delete(tabId);
  consoleByTab.delete(tabId);
  dialogByTab.delete(tabId);
}

function originPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  if (method === "Runtime.consoleAPICalled") {
    appendConsole(source.tabId, {
      level: params.type === "warning" ? "warning" : params.type,
      text: params.args.map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? "").join(" ")
    });
  } else if (method === "Runtime.exceptionThrown") {
    appendConsole(source.tabId, {
      level: "error",
      text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text
    });
  } else if (method === "Log.entryAdded") {
    appendConsole(source.tabId, { level: params.entry.level, text: params.entry.text });
  } else if (method === "Page.javascriptDialogOpening") {
    dialogByTab.set(source.tabId, params);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridge_status") {
    sendResponse({ connected: mcpConnected });
    return;
  }
  if (message?.type === "approval_changed") {
    (message.approved ? Promise.resolve() : detachDebugger(message.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "approval_mode_changed") {
    detachAllDebuggers()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "share_tab") {
    shareTab(message.tabId, message.approveTab === true)
      .then((tab) => sendResponse({ tab }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "unshare_tab") {
    unshareTab(message.tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(connectNativeHost);
chrome.runtime.onStartup.addListener(connectNativeHost);
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId).catch((error) => console.error(error)));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void Promise.all([
    chrome.storage.session.get(`agentTab:${tabId}`),
    approvalMode()
  ])
    .then(([owned, mode]) => owned[`agentTab:${tabId}`] && mode === "site" && detachDebugger(tabId))
    .catch((error) => console.error(error));
});
connectNativeHost();
