import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("browser commands honor ownership, grouping, and approval modes", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = fs.readFileSync(path.join(root, "extension/background.js"), "utf8");
  const sessionStored = {};
  const localStored = { approvalMode: "tab" };
  const tabs = new Map([
    [1, { id: 1, windowId: 1, groupId: -1, active: true, title: "User tab", url: "https://private.example/" }]
  ]);
  const groupUpdates = [];
  const debuggerCommands = [];
  let siteAllowed = false;
  let nextId = 2;
  const listeners = [];
  const sharedEvent = { addListener(listener) { listeners.push(listener); } };
  const chrome = {
    runtime: {
      connectNative: () => ({ onMessage: sharedEvent, onDisconnect: sharedEvent, postMessage() {} }),
      onMessage: sharedEvent,
      onInstalled: sharedEvent,
      onStartup: sharedEvent
    },
    storage: {
      session: storageArea(sessionStored),
      local: storageArea(localStored)
    },
    tabs: {
      create: async ({ url, active }) => {
        const tab = { id: nextId++, windowId: 1, groupId: -1, active, status: "loading", title: "", url };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("No tab");
        return tabs.get(id);
      },
      update: async (id, values) => {
        const tab = { ...tabs.get(id), ...values };
        tabs.set(id, tab);
        return tab;
      },
      remove: async (id) => tabs.delete(id),
      group: async ({ tabIds, groupId = 7 }) => {
        for (const id of tabIds) tabs.set(id, { ...tabs.get(id), groupId });
        return groupId;
      },
      goBack: async () => {},
      goForward: async () => {},
      reload: async () => {},
      onRemoved: sharedEvent,
      onUpdated: sharedEvent
    },
    tabGroups: {
      query: async () => [],
      update: async (groupId, values) => groupUpdates.push({ groupId, ...values })
    },
    permissions: { contains: async () => siteAllowed },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method) => {
        debuggerCommands.push(method);
        if (method === "Runtime.evaluate") {
          return { result: { value: { title: "Mock page", url: tabs.get(2)?.url } } };
        }
        if (method === "Page.getLayoutMetrics") {
          return { cssContentSize: { width: 800, height: 1200 } };
        }
        if (method === "Page.captureScreenshot") return { data: "aW1hZ2U=" };
        return {};
      },
      onEvent: sharedEvent,
      onDetach: sharedEvent
    }
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, console });
  vm.runInContext(source, context);
  const command = (method, args = {}) => vm.runInContext(
    `runCommand(${JSON.stringify(method)}, ${JSON.stringify(args)})`,
    context
  );

  assert.equal((await command("list_tabs")).length, 0);
  const opened = await command("open_tab", { url: "https://example.com/" });
  assert.equal(opened.id, 2);
  assert.equal(opened.groupId, 7);
  assert.deepEqual(groupUpdates, [{
    groupId: 7,
    title: "VSC Copilot Mngd",
    color: "blue",
    collapsed: false
  }]);
  assert.deepEqual(Array.from(await command("list_tabs"), (tab) => tab.id), [2]);
  await assert.rejects(command("navigate_tab", { tabId: 1, url: "https://example.com/" }), /not opened by Copilot/);

  sessionStored["approvedTab:2"] = true;
  await command("navigate_tab", { tabId: 2, url: "https://another.example/" });
  assert.equal((await command("read_page", { tabId: 2 })).url, "https://another.example/");
  const screenshot = await command("screenshot", { tabId: 2, fullPage: true });
  assert.equal(screenshot.data, "aW1hZ2U=");
  assert.ok(debuggerCommands.includes("Page.captureScreenshot"));

  localStored.approvalMode = "site";
  await assert.rejects(command("read_page", { tabId: 2 }), /Site access is not granted/);
  siteAllowed = true;
  assert.equal((await command("read_page", { tabId: 2 })).title, "Mock page");
});

function storageArea(values) {
  return {
    get: async (key) => {
      if (key === null) return { ...values };
      if (typeof key === "string") return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
      return { ...values };
    },
    set: async (updates) => Object.assign(values, updates),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}
