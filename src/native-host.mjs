#!/usr/bin/env node
import net from "node:net";
import { bridgeAddress, createLineDecoder, createNativeDecoder, encodeNative, writeLine } from "./protocol.mjs";

let bridge;
let browserHello;
let retryTimer;
let closed = false;

function sendToExtension(message) {
  process.stdout.write(encodeNative(message));
}

function connectBridge() {
  if (closed || bridge) return;

  const candidate = net.createConnection(bridgeAddress());
  candidate.once("connect", () => {
    bridge = candidate;
    if (browserHello) writeLine(candidate, browserHello);
    sendToExtension({ event: "bridge_status", connected: true });
  });
  candidate.on("data", createLineDecoder(sendToExtension));
  candidate.once("error", () => candidate.destroy());
  candidate.once("close", () => {
    if (bridge === candidate) {
      bridge = undefined;
      sendToExtension({ event: "bridge_status", connected: false });
    }
    if (!closed) retryTimer = setTimeout(connectBridge, 1000);
  });
}

const decodeNative = createNativeDecoder((message) => {
  if (message.event === "browser_hello") browserHello = message;
  if (bridge && !bridge.destroyed) writeLine(bridge, message);
});

process.stdin.on("data", decodeNative);
process.stdin.on("end", () => {
  closed = true;
  clearTimeout(retryTimer);
  bridge?.destroy();
});
process.stdin.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

connectBridge();
