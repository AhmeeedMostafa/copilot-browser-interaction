import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME } from "../src/protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeHost = path.join(root, "src", "native-host.mjs");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform === "win32") {
    installWindows();
  } else if (process.platform === "darwin" || process.platform === "linux") {
    installUnix();
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function installUnix() {
  const executable = path.join(root, "bin", "copilot-browser-host");
  const shellQuote = (value) => `'${value.replaceAll("'", String.raw`'"'"'`)}'`;
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(nativeHost)} "$@"\n`,
    { mode: 0o755 }
  );

  const locations = process.platform === "darwin"
    ? [
        path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
        path.join(os.homedir(), "Library/Application Support/Microsoft Edge/NativeMessagingHosts")
      ]
    : [
        path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts"),
        path.join(os.homedir(), ".config/microsoft-edge/NativeMessagingHosts")
      ];

  for (const directory of locations) {
    fs.mkdirSync(directory, { recursive: true });
    writeManifest(path.join(directory, `${HOST_NAME}.json`), executable);
  }
}

function installWindows() {
  const executable = path.join(root, "bin", "copilot-browser-host.cmd");
  fs.writeFileSync(executable, windowsLauncher(process.execPath, nativeHost));

  const manifestPath = path.join(root, "bin", `${HOST_NAME}.json`);
  writeManifest(manifestPath, executable);
  for (const key of windowsRegistryKeys()) {
    const result = spawnSync("reg.exe", [
      "ADD",
      key,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f"
    ], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Failed to register ${key}`);
  }
}

function writeManifest(destination, executable) {
  fs.writeFileSync(destination, `${JSON.stringify(hostManifest(executable), null, 2)}\n`, { mode: 0o600 });
  console.log(`Installed ${destination}`);
}

export function windowsLauncher(nodePath, hostPath) {
  const escapeBatch = (value) => value.replaceAll("%", "%%");
  return `@echo off\r\n"${escapeBatch(nodePath)}" "${escapeBatch(hostPath)}" %*\r\n`;
}

export function windowsRegistryKeys() {
  return ["Google\\Chrome", "Microsoft\\Edge"].map(
    (vendor) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST_NAME}`
  );
}

export function hostManifest(executable) {
  return {
    name: HOST_NAME,
    description: "Local bridge for Copilot browser interaction",
    path: executable,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  };
}
