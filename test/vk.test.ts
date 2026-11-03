import assert from "node:assert/strict";
import { test } from "node:test";
import { VK, type MessageContext } from "vk-io";
import { parseToken } from "../src/providers/vk/auth.js";
import {
  conversationChats,
  normalizeMessage,
} from "../src/providers/vk/normalize.js";

test("VK accepts a raw user token and a verified OAuth redirect", () => {
  const token = "vk1.a." + "a".repeat(64);
  assert.equal(parseToken(token), token);
  assert.equal(
    parseToken(
      `https://oauth.vk.com/blank.html#access_token=${token}&state=abc`,
      "abc",
    ),
    token,
  );
  assert.throws(
    () =>
      parseToken(
        `https://oauth.vk.com/blank.html#access_token=${token}&state=wrong`,
        "abc",
      ),
    /state/,
  );
  assert.throws(
    () => parseToken(`https://example.org/#access_token=${token}`),
    /VK/,
  );
  assert.throws(() => parseToken("not a token"), /токен/);
});

test("VK conversations show user names, community names and group chat titles", () => {
  const chats = conversationChats({
    items: [
      { conversation: { peer: { id: 42 } } },
      { conversation: { peer: { id: -7 } } },
      {
        conversation: {
          peer: { id: 2000000001 },
          chat_settings: { title: "Друзья" },
        },
      },
    ],
    profiles: [{ id: 42, first_name: "Иван", last_name: "Иванов" }],
    groups: [{ id: 7, name: "Сообщество" }],
  });
  assert.deepEqual(chats, [
    { id: "42", title: "Иван Иванов" },
    { id: "-7", title: "Сообщество" },
    { id: "2000000001", title: "Друзья" },
  ]);
});

test("VK parses personal User Long Poll v19 messages through the SDK", async () => {
  const vk = new VK({ token: "test" });
  let context: MessageContext | undefined;
  vk.updates.on("message_new", (value) => {
    context = value;
  });
  const raw = (flags: number) => [
    10004,
    17,
    flags,
    0,
    2000000001,
    1700000000,
    "Привет",
    { from: "42" },
    {},
    0,
    99,
  ];
  await vk.updates.handlePollingUpdate(raw(0));
  const message = normalizeMessage(context!, "personal");
  assert.equal(message?.provider, "vk");
  assert.equal(message?.messageId, "2000000001:17");
  assert.equal(message?.senderId, "42");
  assert.equal(message?.text, "Привет");
  assert.equal(message?.sentAt, "2023-11-14T22:13:20.000Z");
  await vk.updates.handlePollingUpdate(raw(2));
  assert.equal(normalizeMessage(context!, "personal"), undefined);
});
