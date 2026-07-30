import assert from "node:assert/strict";
import test from "node:test";
import { createLineDecoder, createNativeDecoder, encodeNative } from "../src/protocol.mjs";

test("native messages survive fragmented Unicode input", () => {
  const messages = [];
  const encoded = encodeNative({ text: "hello 🌍" });
  const decode = createNativeDecoder((message) => messages.push(message));
  decode(encoded.subarray(0, 3));
  decode(encoded.subarray(3, 8));
  decode(encoded.subarray(8));
  assert.deepEqual(messages, [{ text: "hello 🌍" }]);
});

test("line decoder handles multiple and fragmented messages", () => {
  const messages = [];
  const decode = createLineDecoder((message) => messages.push(message));
  decode(Buffer.from('{"id":1}\n{"id"'));
  decode(Buffer.from(':2}\n'));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});
