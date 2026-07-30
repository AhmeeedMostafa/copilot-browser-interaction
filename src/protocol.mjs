import os from "node:os";
import path from "node:path";

export const HOST_NAME = "dev.copilot.open_tabs_bridge";
export const EXTENSION_ID = "lpielabaeipgjedahenlleglmchpigca";

export function bridgeAddress() {
  if (process.env.COPILOT_OPEN_TABS_SOCKET) return process.env.COPILOT_OPEN_TABS_SOCKET;
  return process.platform === "win32"
    ? String.raw`\\.\pipe\copilot-open-tabs-${process.env.USERNAME ?? "user"}`
    : path.join(os.homedir(), ".copilot-open-tabs", "bridge.sock");
}

export function daemonAddress() {
  if (process.env.COPILOT_BROWSER_DAEMON_SOCKET) return process.env.COPILOT_BROWSER_DAEMON_SOCKET;
  return process.platform === "win32"
    ? String.raw`\\.\pipe\copilot-browser-interaction-${process.env.USERNAME ?? "user"}`
    : path.join(os.homedir(), ".copilot-open-tabs", "daemon.sock");
}

export function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > 1024 * 1024) throw new Error("Native message exceeds Chrome's 1 MB limit");

  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function createNativeDecoder(onMessage) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 64 * 1024 * 1024) throw new Error("Native message is too large");
      if (buffer.length < length + 4) return;
      onMessage(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      buffer = buffer.subarray(length + 4);
    }
  };
}

export function createLineDecoder(onMessage) {
  let buffer = "";

  return (chunk) => {
    buffer += chunk.toString("utf8");
    for (let newline; (newline = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line));
    }
  };
}

export function writeLine(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}
