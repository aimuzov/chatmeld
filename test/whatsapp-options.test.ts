import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdapter } from "../src/index.js";

test("WhatsApp factory keeps storage functions out of worker messages", async () => {
  const adapter = createAdapter({
    provider: "whatsapp",
    accountId: "test",
    storage: {
      async read() {
        return undefined;
      },
      async writeBatch() {},
    },
  });
  try {
    await assert.rejects(adapter.connect(), { code: "AUTH_REQUIRED" });
  } finally {
    await adapter.disconnect();
  }
});
