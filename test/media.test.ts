import assert from "node:assert/strict";
import { test } from "node:test";
import { Adapter } from "../src/library/adapter.js";
import { MemorySessionStorage } from "../src/index.js";
import {
  encodeMediaReference,
  decodeMediaReference,
  MAX_MEDIA_BYTES,
} from "../src/library/media.js";
import type { MediaInput, ProviderDriver } from "../src/library/types.js";

test("media references are scoped to provider and account", () => {
  const ref = encodeMediaReference("vk", "a", {
    chatId: "42",
    messageId: "900719925474099312345",
  });
  assert.deepEqual(decodeMediaReference(ref, "vk", "a"), {
    chatId: "42",
    messageId: "900719925474099312345",
  });
  assert.throws(() => decodeMediaReference(ref, "vk", "b"), {
    code: "INVALID_OPTIONS",
  });
  assert.throws(() => decodeMediaReference(ref, "telegram", "a"), {
    code: "INVALID_OPTIONS",
  });
  assert.throws(() => decodeMediaReference("secret-invalid", "vk", "a"), {
    code: "INVALID_OPTIONS",
  });
});

test("media validates before invoking SDK and copies caller bytes", async () => {
  let calls = 0;
  const driver: ProviderDriver = {
    async connect() {},
    async authorize() {},
    async listChats() {
      return [];
    },
    async sendMessage() {
      return { externalId: "1" };
    },
    async disconnect() {},
    async sendMedia(_chat, input) {
      calls++;
      assert.equal(input.data[0], 1);
      return { externalId: "42:m" };
    },
  };
  const adapter = new Adapter(
    { provider: "vk", accountId: "a", storage: new MemorySessionStorage() },
    async () => driver,
  );
  await adapter.connect();
  const media: MediaInput = {
    kind: "photo",
    data: new Uint8Array([1, 2, 3]),
    mimeType: "image/jpeg",
    fileName: "photo.jpg",
  };
  const sent = adapter.sendMedia("42", media);
  media.data[0] = 9;
  assert.equal((await sent).externalId, "42:m");
  await assert.rejects(adapter.sendMedia("", media), {
    code: "INVALID_OPTIONS",
  });
  await assert.rejects(
    adapter.sendMedia("42", {
      ...media,
      data: new Uint8Array(MAX_MEDIA_BYTES + 1),
    }),
    { code: "INVALID_OPTIONS" },
  );
  await assert.rejects(
    adapter.sendMedia("42", { ...media, mimeType: "video/mp4" }),
    { code: "INVALID_OPTIONS" },
  );
  assert.equal(calls, 1);
  await adapter.disconnect();
});

test("unsupported media operation leaves a connection usable", async () => {
  const driver: ProviderDriver = {
    async connect() {},
    async authorize() {},
    async listChats() {
      return [{ id: "1", title: "One" }];
    },
    async sendMessage() {
      return { externalId: "1" };
    },
    async disconnect() {},
  };
  const adapter = new Adapter(
    { provider: "vk", accountId: "a", storage: new MemorySessionStorage() },
    async () => driver,
  );
  await adapter.connect();
  await assert.rejects(
    adapter.sendMedia("1", {
      kind: "audio",
      data: new Uint8Array([1]),
      mimeType: "audio/ogg",
    }),
    { code: "UNSUPPORTED_OPERATION" },
  );
  assert.equal((await adapter.listChats())[0]?.id, "1");
  await adapter.disconnect();
});
