import assert from "node:assert/strict";
import { test } from "node:test";
import { createVkDriver } from "../src/providers/vk/library.js";
import { writeStored } from "../src/library/storage.js";
import type { DriverContext, SessionStorage } from "../src/library/types.js";

async function fixture(token?: string) {
  const entries = new Map<string, Uint8Array>();
  const storage: SessionStorage = {
    async read(key) {
      return entries.get(key);
    },
    async writeBatch(changes) {
      for (const change of changes) {
        if (change.type === "set") entries.set(change.key, change.value);
        else entries.delete(change.key);
      }
    },
  };
  if (token) await writeStored(storage, "vk/token", { token });
  const context: DriverContext = {
    storage,
    signal: new AbortController().signal,
    onMessage() {},
    onError() {},
  };
  return { context, driver: createVkDriver({ accountId: "one" }) };
}

test("VK restore never initiates login when storage has no session", async () => {
  const f = await fixture();
  await assert.rejects(f.driver.connect(f.context), /сесси/i);
});

test("VK verifies personal messages access before restoring and sanitizes API errors", async (t) => {
  const f = await fixture("secret-token");
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const method = String(url).split("/").at(-1)!;
    methods.push(method);
    return Response.json(
      method === "users.get"
        ? { response: [{ id: 42 }] }
        : { error: { error_code: 15, error_msg: "secret-token" } },
    );
  });
  await assert.rejects(
    f.driver.connect(f.context),
    (error: Error) =>
      !error.message.includes("secret-token") && /15/.test(error.message),
  );
  assert.deepEqual(methods, ["users.get", "messages.getConversations"]);
  await f.driver.disconnect();
});

test("VK restores, lists named chats, sends scoped IDs and cancels long polling", async (t) => {
  const f = await fixture("secret-token");
  let aborted = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options: RequestInit) => {
      if (String(url).startsWith("https://lp.vk.ru/"))
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      const method = String(url).split("/").at(-1);
      const body = options.body as URLSearchParams;
      if (method === "users.get")
        return Response.json({ response: [{ id: 42 }] });
      if (method === "messages.getLongPollServer")
        return Response.json({
          response: { server: "lp.vk.ru/test", key: "key", ts: "1" },
        });
      if (method === "messages.send") {
        assert.equal(body.get("peer_ids"), "42");
        return Response.json({
          response: [{ peer_id: 42, conversation_message_id: 17 }],
        });
      }
      return Response.json({
        response: {
          count: 1,
          items: [{ conversation: { peer: { id: 42 } } }],
          profiles: [{ id: 42, first_name: "Иван" }],
        },
      });
    },
  );
  await f.driver.connect(f.context);
  assert.deepEqual(await f.driver.listChats(), [{ id: "42", title: "Иван" }]);
  assert.deepEqual(await f.driver.sendMessage("42", "Привет"), {
    externalId: "42:17",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await f.driver.disconnect();
  assert.equal(aborted, true);
});
