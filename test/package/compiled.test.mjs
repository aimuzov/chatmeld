import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAdapter,
  MemorySessionStorage,
  AdapterError,
} from "../../dist/index.js";

test(
  "compiled WhatsApp worker starts without tsx and reports missing authorization",
  { timeout: 15000 },
  async () => {
    const adapter = createAdapter({
      provider: "whatsapp",
      accountId: "compiled",
      storage: new MemorySessionStorage(),
    });
    await assert.rejects(
      adapter.connect(),
      (error) =>
        error instanceof AdapterError && error.code === "AUTH_REQUIRED",
    );
    await adapter.disconnect();
  },
);

test("public package entry constructs isolated adapters without starting I/O", async () => {
  for (const provider of ["telegram", "max", "vk", "whatsapp"]) {
    const adapter = createAdapter({
      provider,
      accountId: "example",
      storage: new MemorySessionStorage(),
      apiId: 123,
      apiHash: "hash",
    });
    assert.equal(adapter.provider, provider);
    await assert.rejects(adapter.listChats(), { code: "AUTH_REQUIRED" });
    await adapter.disconnect();
  }
});
