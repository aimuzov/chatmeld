import assert from "node:assert/strict";
import { test } from "node:test";
import { Adapter } from "../src/library/adapter.js";
import { MemorySessionStorage } from "../src/index.js";
import type { ProviderDriver } from "../src/library/types.js";

function setup(history = true) {
  const driver: ProviderDriver = {
    async connect() {},
    async authorize() {},
    async disconnect() {},
    async listChats() {
      return [];
    },
    async sendMessage() {
      return { externalId: "1" };
    },
    ...(history
      ? {
          async listMessages(chatId: string, options?: { limit?: number }) {
            assert.equal(chatId, "42");
            assert.equal(options?.limit, 25);
            return [
              {
                provider: "vk" as const,
                accountId: "a",
                chatId,
                messageId: "42:1",
                direction: "incoming" as const,
                text: "История",
                sentAt: "2026-11-03T10:00:00.000Z",
                attachments: [],
              },
            ];
          },
        }
      : {}),
  };
  return new Adapter(
    { provider: "vk", accountId: "a", storage: new MemorySessionStorage() },
    async () => driver,
  );
}
test("loads history through connected driver and validates limits", async () => {
  const adapter = setup();
  await assert.rejects(() => adapter.listMessages("42", { limit: 25 }), {
    code: "AUTH_REQUIRED",
  });
  await adapter.connect();
  assert.equal(
    (await adapter.listMessages("42", { limit: 25 }))[0]?.text,
    "История",
  );
  await assert.rejects(() => adapter.listMessages("", { limit: 25 }), {
    code: "INVALID_OPTIONS",
  });
  await assert.rejects(() => adapter.listMessages("42", { limit: 1000 }), {
    code: "INVALID_OPTIONS",
  });
  await adapter.disconnect();
});
test("older drivers without history keep working", async () => {
  const adapter = setup(false);
  await adapter.connect();
  assert.deepEqual(await adapter.listMessages("42"), []);
  await adapter.disconnect();
});
