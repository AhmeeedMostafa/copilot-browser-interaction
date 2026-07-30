const bridge = document.querySelector("#bridge");
const access = document.querySelector("#access");
const modeSelect = document.querySelector("#mode");
const grant = document.querySelector("#grant");
const revoke = document.querySelector("#revoke");

let tab;
let origin;

function originPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "bridge_status" });
  bridge.textContent = status?.connected ? "VS Code bridge connected" : "VS Code bridge not connected";
  bridge.className = status?.connected ? "ok" : "off";

  const { approvalMode = "site" } = await chrome.storage.local.get("approvalMode");
  modeSelect.value = approvalMode;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ownedKey = tab?.id ? `agentTab:${tab.id}` : "";
  const owned = ownedKey && Boolean((await chrome.storage.session.get(ownedKey))[ownedKey]);
  if (!owned || !tab.url || !/^https?:\/\//.test(tab.url)) {
    access.textContent = "Only tabs opened by Copilot can be approved.";
    access.className = "off";
    grant.disabled = true;
    revoke.disabled = true;
    return;
  }

  origin = originPattern(tab.url);
  let allowed;
  if (approvalMode === "tab") {
    const key = `approvedTab:${tab.id}`;
    allowed = Boolean((await chrome.storage.session.get(key))[key]);
    access.textContent = `Copilot tab ${tab.id}: ${allowed ? "allowed for any website" : "not allowed"}`;
    grant.textContent = "Allow this tab";
  } else {
    allowed = await chrome.permissions.contains({ origins: [origin] });
    access.textContent = `${new URL(tab.url).hostname}: ${allowed ? "allowed" : "not allowed"}`;
    grant.textContent = "Allow this site";
  }
  access.className = allowed ? "ok" : "off";
  grant.disabled = allowed;
  revoke.disabled = !allowed;
}

modeSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ approvalMode: modeSelect.value });
  await chrome.runtime.sendMessage({ type: "approval_mode_changed" });
  await refresh();
});

grant.addEventListener("click", async () => {
  if (modeSelect.value === "tab") {
    await chrome.storage.session.set({ [`approvedTab:${tab.id}`]: true });
  } else {
    await chrome.permissions.request({ origins: [origin] });
  }
  await chrome.runtime.sendMessage({ type: "approval_changed", tabId: tab.id, approved: true });
  await refresh();
});

revoke.addEventListener("click", async () => {
  if (modeSelect.value === "tab") {
    await chrome.storage.session.remove(`approvedTab:${tab.id}`);
  } else {
    await chrome.permissions.remove({ origins: [origin] });
  }
  await chrome.runtime.sendMessage({ type: "approval_changed", tabId: tab.id, approved: false });
  await refresh();
});

refresh();
