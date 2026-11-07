import assert from "node:assert/strict";
import { test } from "node:test";
import { Adapter } from "../src/library/adapter.js";
import { MemorySessionStorage } from "../src/index.js";
import type {
  DriverContext,
  MessageReceipt,
  ProviderDriver,
} from "../src/library/types.js";

test("receipt handlers are scoped, awaited and removed on unsubscribe", async () => {
  let context!: DriverContext;
  const driver: ProviderDriver = {
    async connect(value) {
      context = value;
    },
    async authorize() {},
    async disconnect() {},
    async listChats() {
      return [];
    },
    async sendMessage() {
      return { externalId: "42:1" };
    },
  };
  const adapter = new Adapter(
    { provider: "vk", accountId: "a", storage: new MemorySessionStorage() },
    async () => driver,
  );
  const received: MessageReceipt[] = [];
  const remove = adapter.onReceipt(async (receipt) => {
    await Promise.resolve();
    received.push(receipt);
  });
  await adapter.connect();
  const receipt: MessageReceipt = {
    provider: "vk",
    accountId: "a",
    chatId: "42",
    status: "read",
    throughMessageId: "42:17",
  };
  context.onReceipt!(receipt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [receipt]);
  remove();
  context.onReceipt!(receipt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  await adapter.disconnect();
});
