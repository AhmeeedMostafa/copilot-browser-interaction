const bridge = document.querySelector("#bridge");
const access = document.querySelector("#access");
const modeSelect = document.querySelector("#mode");
const autoApprove = document.querySelector("#auto-approve");
const share = document.querySelector("#share");
const grant = document.querySelector("#grant");
const revoke = document.querySelector("#revoke");
const unshare = document.querySelector("#unshare");

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

  const {
    approvalMode = "site",
    autoApproveCopilotTabs = false
  } = await chrome.storage.local.get(["approvalMode", "autoApproveCopilotTabs"]);
  modeSelect.value = approvalMode;
  autoApprove.checked = autoApproveCopilotTabs;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ownedKey = tab?.id ? `agentTab:${tab.id}` : "";
  const owner = ownedKey && (await chrome.storage.session.get(ownedKey))[ownedKey];
  const owned = Boolean(owner);
  const shareable = Boolean(tab?.url && /^https?:\/\//.test(tab.url));
  if (!owned) {
    access.textContent = shareable
      ? "This user-opened tab is not shared with Copilot."
      : "Only HTTP(S) tabs can be shared.";
    access.className = "off";
    share.hidden = false;
    share.disabled = !shareable;
    grant.hidden = true;
    revoke.hidden = true;
    unshare.hidden = true;
    return;
  }
  if (!shareable) {
    access.textContent = "This managed tab is not an HTTP(S) page.";
    access.className = "off";
    share.hidden = true;
    grant.hidden = true;
    revoke.hidden = true;
    unshare.hidden = false;
    unshare.disabled = false;
    return;
  }

  share.hidden = true;
  grant.hidden = false;
  revoke.hidden = false;
  unshare.hidden = false;
  unshare.disabled = false;
  origin = originPattern(tab.url);
  let allowed;
  if (String(owner).startsWith("copilot") && autoApproveCopilotTabs) {
    allowed = true;
    access.textContent = `Copilot tab ${tab.id}: automatically allowed`;
    grant.textContent = "Automatically allowed";
  } else if (approvalMode === "tab") {
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
  revoke.disabled = !allowed || (String(owner).startsWith("copilot") && autoApproveCopilotTabs);
}

share.addEventListener("click", async () => {
  if (modeSelect.value === "site" && !(await chrome.permissions.request({ origins: [originPattern(tab.url)] }))) {
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "share_tab",
    tabId: tab.id,
    approveTab: modeSelect.value === "tab"
  });
  if (response?.error) {
    access.textContent = response.error;
    access.className = "off";
    return;
  }
  await refresh();
});

unshare.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "unshare_tab", tabId: tab.id });
  if (response?.error) {
    access.textContent = response.error;
    access.className = "off";
    return;
  }
  await refresh();
});

/*
 * Approval remains separate from ownership so access can be revoked without
 * closing or ungrouping the managed tab.
 */

modeSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ approvalMode: modeSelect.value });
  await chrome.runtime.sendMessage({ type: "approval_mode_changed" });
  await refresh();
});

autoApprove.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoApproveCopilotTabs: autoApprove.checked });
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
