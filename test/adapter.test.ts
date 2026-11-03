import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "teleproto";
import bigInt from "big-integer";
import { normalizeMessage } from "../src/providers/telegram/normalize.js";
import { readSession, saveSession } from "../src/providers/telegram/session.js";
import { deliverWebhook } from "../src/core/webhook.js";

test("normalizes IDs without losing precision and distinguishes chats", () => {
  const message = new Api.Message({
    id: 12,
    peerId: new Api.PeerChannel({ channelId: bigInt("1234567890") }),
    fromId: new Api.PeerUser({ userId: bigInt("9007199254740993") }),
    date: 1700000000,
    message: "Привет",
    out: false,
  });
  const result = normalizeMessage(message, "personal");
  assert.equal(result.chatId, "-1001234567890");
  assert.equal(result.senderId, "9007199254740993");
  assert.equal(result.messageId, "-1001234567890:12");
  assert.equal(result.accountId, "personal");
  assert.equal(result.provider, "telegram");
  assert.equal(result.sentAt, "2023-11-14T22:13:20.000Z");
  assert.equal(result.text, "Привет");
  assert.equal(result.direction, "incoming");
});

test("preserves media-only messages and outgoing direction", () => {
  const message = new Api.Message({
    id: 13,
    peerId: new Api.PeerUser({ userId: bigInt(42) }),
    date: 1700000000,
    message: "",
    out: true,
    media: new Api.MessageMediaPhoto({}),
  });
  const result = normalizeMessage(message, "personal");
  assert.equal(result.direction, "outgoing");
  assert.deepEqual(result.attachments, [{ kind: "MessageMediaPhoto" }]);
});

test("stores session atomically with private permissions and can replace it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-adapter-"));
  const path = join(dir, "private", "telegram.session");
  try {
    assert.equal(await readSession(path), "");
    await saveSession(path, "first");
    await saveSession(path, "second");
    assert.equal(await readSession(path), "second");
    assert.equal(await readFile(path, "utf8"), "second");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "private"))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("webhook sends JSON and bearer token to a real HTTP receiver", async () => {
  let body = "";
  let authorization: string | undefined;
  const server = createServer(async (req, res) => {
    authorization = req.headers.authorization;
    for await (const chunk of req) body += chunk.toString();
    res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await deliverWebhook(
      `http://127.0.0.1:${address.port}`,
      { text: "Привет" },
      "secret",
    );
    assert.deepEqual(JSON.parse(body), { text: "Привет" });
    assert.equal(authorization, "Bearer secret");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("webhook fails visibly on HTTP errors instead of acknowledging delivery", async () => {
  const server = createServer((_req, res) =>
    res.writeHead(503).end("unavailable"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      deliverWebhook(`http://127.0.0.1:${address.port}`, {}),
      /503/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
