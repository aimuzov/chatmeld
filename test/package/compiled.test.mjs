import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
  for (const provider of ["telegram", "max", "vk", "whatsapp", "instagram"]) {
    const adapter = createAdapter({
      provider,
      accountId: "example",
      storage: new MemorySessionStorage(),
      apiId: 123,
      apiHash: "hash",
      username: "example",
    });
    assert.equal(adapter.provider, provider);
    await assert.rejects(adapter.listChats(), { code: "AUTH_REQUIRED" });
    await adapter.disconnect();
  }
});

test(
  "compiled Instagram worker loads its SDK and cancels before sending credentials",
  { timeout: 15000 },
  async () => {
    const control = new AbortController();
    const adapter = createAdapter({
      provider: "instagram",
      accountId: "compiled",
      username: "example",
      storage: new MemorySessionStorage(),
      pythonCommand: existsSync("python/.venv/bin/python")
        ? resolve("python/.venv/bin/python")
        : "python3",
    });
    let asked = false;
    try {
      await assert.rejects(
        adapter.authorize({
          signal: control.signal,
          onEvent(event) {
            if (event.type === "challenge" && event.kind === "password") {
              asked = true;
              control.abort();
            }
          },
        }),
        { code: "AUTH_CANCELLED" },
      );
      assert.equal(asked, true);
    } finally {
      await adapter.disconnect();
    }
  },
);
