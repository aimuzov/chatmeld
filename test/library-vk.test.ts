import assert from "node:assert/strict";
import { test } from "node:test";
import { Upload } from "vk-io";
import { createVkDriver } from "../src/providers/vk/library.js";
import { readStored, writeStored } from "../src/library/storage.js";
import type { DriverContext, SessionStorage } from "../src/library/types.js";

async function fixture(
  token?: string,
  restore?: Parameters<typeof createVkDriver>[1],
) {
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
  return { context, driver: createVkDriver({ accountId: "one" }, restore) };
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

test("VK publishes private outgoing read watermarks from long polling", async (t) => {
  const f = await fixture("test-token");
  const receipts: unknown[] = [];
  let received!: () => void;
  const done = new Promise<void>((resolve) => {
    received = resolve;
  });
  f.context.onReceipt = (receipt) => {
    receipts.push(receipt);
    received();
  };
  let first = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options: RequestInit) => {
      if (String(url).startsWith("https://lp.vk.ru/")) {
        if (first) {
          first = false;
          return Response.json({
            ts: "2",
            updates: [
              [10006, 42, 9],
              [10007, 2000000001, 10],
              [10007, 42, 17],
            ],
          });
        }
        options.signal!.throwIfAborted();
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }
      const method = String(url).split("/").at(-1);
      if (method === "users.get")
        return Response.json({ response: [{ id: 42 }] });
      if (method === "messages.getLongPollServer")
        return Response.json({
          response: { server: "lp.vk.ru/test", key: "key", ts: "1" },
        });
      return Response.json({ response: { items: [], count: 0 } });
    },
  );
  await f.driver.connect(f.context);
  try {
    await done;
    assert.deepEqual(receipts, [
      {
        provider: "vk",
        accountId: "one",
        chatId: "42",
        status: "read",
        throughMessageId: "42:17",
      },
    ]);
  } finally {
    await f.driver.disconnect();
  }
});

test("VK community authorizes with a key, lists chats, receives and replies", async (t) => {
  const { context } = await fixture();
  const driver = createVkDriver({ accountId: "community", communityId: 42 });
  t.after(() => driver.disconnect());
  context.auth = {
    qr() {
      assert.fail("Unexpected QR");
    },
    progress() {},
    async challenge(challenge) {
      assert.equal(challenge.kind, "password");
      return "community-token";
    },
  };
  const incoming: unknown[] = [];
  context.onMessage = (message) => {
    incoming.push(message.text);
  };
  const upload = t.mock.method(
    Upload.prototype,
    "audioMessage",
    async (params: { peer_id: number; source: { contentType: string } }) => {
      assert.equal(params.peer_id, 7);
      assert.equal(params.source.contentType, "audio/ogg");
      return { toString: (): string => "audio_message-42_9" };
    },
  );
  let first = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options: RequestInit) => {
      if (String(url).startsWith("https://lp.vk.ru/")) {
        assert.equal(new URL(String(url)).searchParams.has("mode"), false);
        if (first) {
          first = false;
          return Response.json({
            ts: "2",
            updates: [
              {
                type: "message_new",
                group_id: 42,
                object: {
                  message: {
                    id: 11,
                    conversation_message_id: 3,
                    peer_id: 7,
                    from_id: 7,
                    out: 0,
                    date: 100,
                    text: "Вопрос",
                    attachments: [],
                  },
                  client_info: {},
                },
              },
            ],
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
            { once: true },
          );
        });
      }
      if (String(url) === "https://audio.userapi.com/voice.mp3")
        return new Response("recording", {
          headers: { "content-type": "audio/mpeg" },
        });
      const body = options.body as URLSearchParams;
      assert.equal(body.get("access_token"), "community-token");
      const method = String(url).split("/").at(-1);
      if (method === "groups.getById")
        return Response.json({ response: { groups: [{ id: 42 }] } });
      assert.equal(body.get("group_id"), "42");
      switch (method) {
        case "groups.getLongPollServer":
          return Response.json({
            response: { server: "https://lp.vk.ru/test", key: "key", ts: "1" },
          });
        case "messages.getConversations":
          return Response.json({
            response: {
              count: 1,
              items: [{ conversation: { peer: { id: 7 } } }],
              profiles: [{ id: 7, first_name: "Анна" }],
            },
          });
        case "messages.getHistory":
          return Response.json({ response: { count: 0, items: [] } });
        case "messages.getByConversationMessageId":
          assert.equal(body.get("conversation_message_ids"), "5");
          return Response.json({
            response: {
              items: [
                {
                  peer_id: 7,
                  conversation_message_id: 5,
                  attachments: [
                    {
                      type: "audio_message",
                      audio_message: {
                        link_mp3: "https://audio.userapi.com/voice.mp3",
                        link_ogg: "https://audio.userapi.com/voice.ogg",
                      },
                    },
                  ],
                },
              ],
            },
          });
        case "messages.send":
          assert.equal(body.get("peer_ids"), "7");
          if (body.has("attachment")) {
            assert.equal(body.get("attachment"), "audio_message-42_9");
            return Response.json({
              response: [{ peer_id: 7, conversation_message_id: 5 }],
            });
          }
          assert.equal(body.get("message"), "Ответ");
          return Response.json({
            response: [{ peer_id: 7, conversation_message_id: 4 }],
          });
        default:
          assert.fail(`Unexpected API method: ${method}`);
      }
    },
  );
  await driver.authorize(context);
  assert.deepEqual(await driver.listChats(), [{ id: "7", title: "Анна" }]);
  assert.deepEqual(await driver.listMessages!("7"), []);
  assert.deepEqual(await driver.sendMessage("7", "Ответ"), {
    externalId: "7:4",
  });
  const voice = await driver.sendMedia!("7", {
    kind: "audio",
    voice: true,
    mimeType: "audio/ogg",
    data: new Uint8Array([1]),
  });
  assert.equal(voice.externalId, "7:5");
  assert.equal(voice.attachments?.[0]?.kind, "audio");
  assert.ok(voice.attachments?.[0]?.reference);
  const downloaded = await driver.downloadMedia!(
    voice.attachments![0]!.reference!,
  );
  assert.equal(downloaded.mimeType, "audio/mpeg");
  assert.equal(Buffer.from(downloaded.data).toString(), "recording");
  assert.equal(upload.mock.callCount(), 1);
  assert.deepEqual(incoming, ["Вопрос"]);
  await driver.disconnect();
  await driver.connect(context);
});

test("VK renews an expired token once for concurrent requests and persists the verified session", async (t) => {
  const browser = { cookies: [], origins: [] };
  let restores = 0;
  const f = await fixture("old-token", async (options) => {
    restores++;
    assert.deepEqual(options.state, browser);
    assert.equal(options.previousToken, "old-token");
    assert.equal(await options.validate("new-token", options.signal), true);
    return { token: "new-token", state: browser };
  });
  await writeStored(f.context.storage, "vk/token", {
    token: "old-token",
    browser,
    userId: 42,
  });
  let expired = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, options: RequestInit) => {
      if (String(url).startsWith("https://lp.vk.ru/"))
        return new Promise<Response>((_, reject) =>
          options.signal!.addEventListener(
            "abort",
            () => reject(Error("aborted")),
            { once: true },
          ),
        );
      const method = String(url).split("/").at(-1);
      const token = (options.body as URLSearchParams).get("access_token");
      if (token === "old-token" && expired)
        return Response.json({
          error: { error_code: 5, error_msg: "expired" },
        });
      if (method === "users.get")
        return Response.json({ response: [{ id: 42 }] });
      if (method === "messages.getLongPollServer")
        return Response.json({
          response: { server: "lp.vk.ru/test", key: "key", ts: "1" },
        });
      return Response.json({ response: { count: 0, items: [] } });
    },
  );
  try {
    await f.driver.connect(f.context);
    expired = true;
    await Promise.all([f.driver.listChats(), f.driver.listChats()]);
    assert.equal(restores, 1);
    assert.deepEqual(await readStored(f.context.storage, "vk/token"), {
      token: "new-token",
      browser,
      userId: 42,
    });
  } finally {
    await f.driver.disconnect();
  }
});
