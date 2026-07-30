import assert from "node:assert/strict";
import test from "node:test";
import {
  hostManifest,
  windowsLauncher,
  windowsRegistryKeys
} from "../scripts/install-host.mjs";

test("Windows installer artifacts use user-level Chrome and Edge registration", () => {
  const launcher = windowsLauncher(
    String.raw`C:\Program Files\nodejs\node.exe`,
    String.raw`C:\Users\Ahmed\copilot-extension\src\native-host.mjs`
  );
  assert.match(launcher, /node\.exe"/);
  assert.match(launcher, /native-host\.mjs" %\*/);

  assert.deepEqual(windowsRegistryKeys(), [
    String.raw`HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.copilot.open_tabs_bridge`,
    String.raw`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\dev.copilot.open_tabs_bridge`
  ]);

  const manifest = hostManifest(String.raw`C:\host\copilot-browser-host.cmd`);
  assert.equal(manifest.path, String.raw`C:\host\copilot-browser-host.cmd`);
  assert.deepEqual(manifest.allowed_origins, [
    "chrome-extension://lpielabaeipgjedahenlleglmchpigca/"
  ]);
});
