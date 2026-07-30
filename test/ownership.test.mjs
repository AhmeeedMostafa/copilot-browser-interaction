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
  const ungroupedTabs = [];
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
      ungroup: async (tabId) => {
        ungroupedTabs.push(tabId);
        tabs.set(tabId, { ...tabs.get(tabId), groupId: -1 });
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
  const context = vm.createContext({
    chrome,
    navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36" },
    URL,
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(source, context);
  const command = (method, args = {}) => vm.runInContext(
    `runCommand(${JSON.stringify(method)}, ${JSON.stringify(args)})`,
    context
  );

  assert.equal((await command("list_tabs")).length, 0);
  const opened = await command("open_tab", {
    url: "https://example.com/",
    sessionId: "session-a"
  });
  assert.equal(opened.id, 2);
  assert.equal(sessionStored["agentTab:2"], "copilot:session-a");
  assert.equal(opened.groupId, 7);
  assert.deepEqual(groupUpdates, [{
    groupId: 7,
    title: "VSC Copilot Mngd",
    color: "blue",
    collapsed: false
  }]);
  const listed = await command("list_tabs");
  assert.deepEqual(Array.from(listed, (tab) => tab.id), [2]);
  assert.equal(listed[0].source, "copilot");
  assert.equal(listed[0].sessionId, "session-a");
  await assert.rejects(command("navigate_tab", { tabId: 1, url: "https://example.com/" }), /not opened by Copilot/);

  const shared = await vm.runInContext("shareTab(1, true)", context);
  assert.equal(shared.groupId, 7);
  assert.equal(sessionStored["agentTab:1"], "shared");
  assert.equal(sessionStored["approvedTab:1"], true);
  assert.deepEqual(Array.from(await command("list_tabs"), (tab) => tab.id).sort(), [1, 2]);
  await vm.runInContext("unshareTab(1)", context);
  assert.deepEqual(ungroupedTabs, [1]);
  assert.equal(sessionStored["agentTab:1"], undefined);
  assert.equal(sessionStored["approvedTab:1"], undefined);
  assert.deepEqual(Array.from(await command("list_tabs"), (tab) => tab.id), [2]);

  delete sessionStored["approvedTab:2"];
  localStored.approvalMode = "site";
  localStored.autoApproveCopilotTabs = true;
  siteAllowed = false;
  assert.equal((await command("read_page", { tabId: 2 })).title, "Mock page");

  sessionStored["agentTab:1"] = "shared";
  await assert.rejects(command("read_page", { tabId: 1 }), /Site access is not granted/);
  delete sessionStored["agentTab:1"];

  localStored.autoApproveCopilotTabs = false;
  await assert.rejects(command("read_page", { tabId: 2 }), /Site access is not granted/);

  sessionStored["approvedTab:2"] = true;
  localStored.approvalMode = "tab";
  await command("navigate_tab", { tabId: 2, url: "https://another.example/" });
  assert.equal((await command("read_page", { tabId: 2 })).url, "https://another.example/");
  const screenshot = await command("screenshot", { tabId: 2, fullPage: true });
  assert.equal(screenshot.data, "aW1hZ2U=");
  assert.ok(debuggerCommands.includes("Page.captureScreenshot"));

  localStored.approvalMode = "site";
  await assert.rejects(command("read_page", { tabId: 2 }), /Site access is not granted/);
  siteAllowed = true;
  assert.equal((await command("read_page", { tabId: 2 })).title, "Mock page");
  const ended = await command("end_session", { sessionId: "session-a" });
  assert.equal(ended.detachedTabs, 1);
  assert.deepEqual(Array.from(await command("list_tabs"), (tab) => tab.id), [2]);
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
