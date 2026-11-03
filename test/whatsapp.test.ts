import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONNECTION_CONFIG,
  generateRegistrationNode,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";
import { connectionOptions } from "../src/providers/whatsapp/connection.js";
import { hasSession } from "../src/providers/whatsapp/auth.js";
import { normalizeMessage } from "../src/providers/whatsapp/normalize.js";
import { WhatsAppCatalog } from "../src/providers/whatsapp/catalog.js";
import { WhatsAppProvider } from "../src/providers/whatsapp/provider.js";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("WhatsApp handshake advertises a web browser rather than the rejected DARWIN desktop platform", () => {
  const payload = generateRegistrationNode(initAuthCreds(), {
    ...DEFAULT_CONNECTION_CONFIG,
    ...connectionOptions(),
  });
  assert.equal(
    payload.webInfo?.webSubPlatform,
    proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER,
  );
  assert.equal(
    payload.userAgent?.platform,
    proto.ClientPayload.UserAgent.Platform.WEB,
  );
});

test("WhatsApp restores a QR-paired session even when registered remains false", () => {
  const creds = initAuthCreds();
  assert.equal(hasSession(creds), false);
  creds.me = { id: "79990000000:1@s.whatsapp.net", name: "Иван" };
  assert.equal(creds.registered, false);
  assert.equal(hasSession(creds), true);
});

test("WhatsApp unwraps ephemeral text and preserves the sender in a group", () => {
  const message = proto.WebMessageInfo.fromObject({
    key: {
      id: "abc",
      remoteJid: "123@g.us",
      participant: "42:3@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1700000000,
    pushName: "Иван Иванов",
    message: {
      ephemeralMessage: {
        message: { extendedTextMessage: { text: "Привет" } },
      },
    },
  });
  const result = normalizeMessage(message, "personal");
  assert.equal(result?.provider, "whatsapp");
  assert.equal(result?.accountId, "personal");
  assert.equal(result?.chatId, "123@g.us");
  assert.equal(result?.messageId, "123@g.us:abc");
  assert.equal(result?.senderId, "42@s.whatsapp.net");
  assert.equal(result?.displayName, "Иван Иванов");
  assert.equal(result?.text, "Привет");
  assert.equal(result?.sentAt, "2023-11-14T22:13:20.000Z");
});

test("WhatsApp does not forward outgoing messages, status or protocol updates", () => {
  for (const message of [
    {
      key: { id: "1", remoteJid: "42@lid", fromMe: true },
      message: { conversation: "Своё" },
    },
    {
      key: { id: "2", remoteJid: "status@broadcast" },
      message: { conversation: "Статус" },
    },
    {
      key: { id: "3", remoteJid: "42@lid" },
      message: { protocolMessage: { type: 0 } },
    },
  ])
    assert.equal(
      normalizeMessage(proto.WebMessageInfo.fromObject(message), "personal"),
      undefined,
    );
});

test("WhatsApp keeps captions, attachment types and LID addresses", () => {
  const result = normalizeMessage(
    proto.WebMessageInfo.fromObject({
      key: { id: "image", remoteJid: "42@lid" },
      messageTimestamp: 1700000000,
      message: { imageMessage: { caption: "Фото" } },
    }),
    "personal",
  );
  assert.equal(result?.chatId, "42@lid");
  assert.equal(result?.text, "Фото");
  assert.deepEqual(result?.attachments, [{ kind: "photo" }]);
});

test("WhatsApp resolves contact names across phone and LID aliases without changing chat IDs", () => {
  const catalog = new WhatsAppCatalog();
  catalog.chats([{ id: "42@lid" }, { id: "123@g.us", name: "Работа" }]);
  catalog.contacts([
    { id: "79990000000@s.whatsapp.net", lid: "42@lid", name: "Иван Иванов" },
  ]);
  const chats = catalog.list();
  assert.deepEqual(
    chats.find((chat) => chat.id === "42@lid"),
    { id: "42@lid", title: "Иван Иванов" },
  );
  assert.deepEqual(
    chats.find((chat) => chat.id === "123@g.us"),
    { id: "123@g.us", title: "Работа" },
  );
});

test("WhatsApp catalog survives serialization and partial contact updates", () => {
  const catalog = new WhatsAppCatalog();
  catalog.chats([{ id: "42@lid" }]);
  catalog.contacts([
    {
      id: "42@lid",
      name: "Иван Иванов",
      phoneNumber: "79990000000@s.whatsapp.net",
    },
  ]);
  const restored = new WhatsAppCatalog();
  restored.restore(JSON.parse(JSON.stringify(catalog.snapshot())));
  restored.contacts([{ id: "79990000000@s.whatsapp.net", notify: "Иван" }]);
  assert.deepEqual(restored.list(), [{ id: "42@lid", title: "Иван Иванов" }]);
});

test("WhatsApp joining two existing aliases does not discard a known contact name", () => {
  const catalog = new WhatsAppCatalog();
  catalog.chats([{ id: "79990000000@s.whatsapp.net" }]);
  catalog.contacts([{ id: "79990000000@s.whatsapp.net", name: "Иван Иванов" }]);
  catalog.contacts([{ id: "42@lid" }]);
  catalog.contacts([
    { id: "42@lid", phoneNumber: "79990000000@s.whatsapp.net" },
  ]);
  assert.deepEqual(catalog.list(), [
    { id: "79990000000@s.whatsapp.net", title: "Иван Иванов" },
  ]);
});

test("WhatsApp does not label the recipient with the sender's own pushName", () => {
  const catalog = new WhatsAppCatalog();
  catalog.observe({
    key: { remoteJid: "42@lid", fromMe: true },
    pushName: "Моё имя",
  });
  assert.deepEqual(catalog.list(), [{ id: "42@lid", title: "42@lid" }]);
  catalog.observe({
    key: { remoteJid: "42@lid", fromMe: false },
    pushName: "Иван Иванов",
  });
  assert.deepEqual(catalog.list(), [{ id: "42@lid", title: "Иван Иванов" }]);
});

test("WhatsApp worker requires an explicit login and protects its local session directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-adapter-wa-"));
  const provider = new WhatsAppProvider("test", directory);
  try {
    await provider.connect();
    await assert.rejects(
      provider.requireAuthorization(),
      /Нет сессии WhatsApp/,
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await provider.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("WhatsApp reads cached chat names without credentials or a second network connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-adapter-wa-catalog-"));
  const provider = new WhatsAppProvider("test", directory);
  try {
    await writeFile(
      join(directory, "catalog.json"),
      JSON.stringify({
        chats: [{ id: "42@lid", title: "" }],
        contacts: [{ id: "42@lid", name: "Иван Иванов" }],
      }),
    );
    await provider.connect();
    assert.deepEqual(await provider.listChats(), [
      { id: "42@lid", title: "Иван Иванов" },
    ]);
  } finally {
    await provider.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
