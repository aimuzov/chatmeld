import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { FileReferenceExpiredError } from "teleproto/errors";
import { Adapter } from "../src/library/adapter.js";
import { Upload } from "vk-io";
import { normalizeAttachments } from "../src/providers/vk/normalize.js";
import {
  proto,
  type downloadMediaMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { createTelegramDriver } from "../src/providers/telegram/library.js";
import { createVkDriver } from "../src/providers/vk/library.js";
import { WhatsAppLibraryRuntime } from "../src/providers/whatsapp/library-runtime.js";
import { normalizeMessage as normalizeTelegram } from "../src/providers/telegram/normalize.js";
import { normalizeMessage as normalizeWhatsApp } from "../src/providers/whatsapp/normalize.js";
import {
  encodeMediaReference,
  decodeMediaReference,
  MAX_MEDIA_BYTES,
} from "../src/library/media.js";
import { writeStored } from "../src/library/storage.js";
import type { DriverContext, MediaInput } from "../src/library/types.js";

const bytes = new Uint8Array([1, 2, 3]);
const inputs: MediaInput[] = [
  {
    kind: "photo",
    data: bytes,
    mimeType: "image/jpeg",
    fileName: "photo.jpg",
    caption: "Caption",
  },
  {
    kind: "video",
    data: bytes,
    mimeType: "video/mp4",
    fileName: "video.mp4",
    caption: "Caption",
  },
  { kind: "audio", data: bytes, mimeType: "audio/mpeg", fileName: "audio.mp3" },
];
function context(): DriverContext {
  const data = new Map<string, Uint8Array>();
  return {
    storage: {
      read: async (key) => data.get(key),
      async writeBatch(changes) {
        for (const c of changes)
          if (c.type === "set") data.set(c.key, c.value);
          else data.delete(c.key);
      },
    },
    signal: new AbortController().signal,
    onMessage() {},
    onError() {},
  };
}
function tgMessage(media: Api.TypeMessageMedia) {
  return new Api.Message({
    id: 7,
    peerId: new Api.PeerUser({ userId: bigInt(42) }),
    date: 1700000000,
    message: "Caption",
    media,
  });
}
function tgPhoto() {
  return tgMessage(
    new Api.MessageMediaPhoto({
      photo: new Api.Photo({
        id: bigInt("9007199254740993"),
        accessHash: bigInt(1),
        fileReference: Buffer.alloc(0),
        date: 1700000000,
        sizes: [],
        dcId: 1,
      }),
    }),
  );
}
function tgDocument(mimeType: string, size = 3) {
  return tgMessage(
    new Api.MessageMediaDocument({
      document: new Api.Document({
        id: bigInt("9007199254740993"),
        accessHash: bigInt(1),
        fileReference: Buffer.alloc(0),
        date: 1700000000,
        mimeType,
        size: bigInt(size),
        thumbs: [],
        dcId: 1,
        attributes: [new Api.DocumentAttributeFilename({ fileName: "media" })],
      }),
    }),
  );
}

test("Telegram sends all media kinds and downloads references resolved from original messages", async (t) => {
  t.mock.method(TelegramClient.prototype, "connect", async () => true);
  t.mock.method(
    TelegramClient.prototype,
    "checkAuthorization",
    async () => true,
  );
  t.mock.method(TelegramClient.prototype, "getMe", async () => ({
    bot: false,
  }));
  t.mock.method(TelegramClient.prototype, "destroy", async () => undefined);
  t.mock.method(TelegramClient.prototype, "iterDialogs", async function* () {
    yield { id: bigInt(42), title: "Peer" };
  });
  let tgError = false;
  const sends: unknown[] = [];
  t.mock.method(
    TelegramClient.prototype,
    "sendFile",
    async (
      id: string,
      options: { file: { buffer: Buffer; name: string }; parseMode: unknown },
    ) => {
      if (tgError) throw Error("SECRET SDK ERROR");
      assert.equal(id, "42");
      assert.equal(options.parseMode, false);
      assert.deepEqual(options.file.buffer, Buffer.from(bytes));
      sends.push(options);
      return { id: 8 };
    },
  );
  let message = tgPhoto();
  t.mock.method(
    TelegramClient.prototype,
    "getMessages",
    async (id: string, options: { ids: number[] }) => {
      assert.equal(id, "42");
      assert.deepEqual(options.ids, [7]);
      return [message];
    },
  );
  let downloads = 0;
  t.mock.method(TelegramClient.prototype, "downloadMedia", async () => {
    downloads++;
    return Buffer.from(bytes);
  });
  const c = context();
  await writeStored(c.storage, "telegram/session", { session: "" });
  const driver = createTelegramDriver({
    accountId: "a",
    apiId: 1,
    apiHash: "test",
  });
  await driver.connect(c);
  try {
    for (const input of inputs)
      assert.deepEqual(await driver.sendMedia!("42", input), {
        externalId: "42:8",
      });
    assert.equal(sends.length, 3);
    for (const [mime, kind] of [
      ["image/jpeg", "photo"],
      ["video/mp4", "video"],
      ["audio/mpeg", "audio"],
    ]) {
      message = kind === "photo" ? tgPhoto() : tgDocument(mime!);
      const attachment = normalizeTelegram(message, "a").attachments[0]!;
      assert.equal(attachment.kind, kind);
      assert.ok(attachment.reference);
      assert.deepEqual(
        decodeMediaReference(attachment.reference!, "telegram", "a"),
        { chatId: "42", messageId: "7" },
      );
      const file = await driver.downloadMedia!(attachment.reference!);
      assert.equal(file.mimeType, mime);
      assert.deepEqual(file.data, bytes);
    }
    message = tgDocument("video/mp4", MAX_MEDIA_BYTES + 1);
    const ref = normalizeTelegram(message, "a").attachments[0]!.reference!;
    await assert.rejects(driver.downloadMedia!(ref));
    assert.equal(downloads, 3);
    await assert.rejects(
      driver.sendMedia!("42", {
        ...inputs[0]!,
        data: new Uint8Array(MAX_MEDIA_BYTES + 1),
      }),
    );
    assert.equal(sends.length, 3);
    tgError = true;
    await assert.rejects(
      driver.sendMedia!("42", inputs[0]!),
      (error: Error) => !error.message.includes("SECRET"),
    );
  } finally {
    await driver.disconnect();
  }
});

test("VK uploads all media kinds and resolves photo/audio/video from message references", async (t) => {
  const uploaded: string[] = [];
  for (const [method, kind] of [
    ["messagePhoto", "photo"],
    ["video", "video"],
    ["messageDocument", "doc"],
  ] as const)
    t.mock.method(
      Upload.prototype,
      method,
      async (options: {
        source: { value: Buffer; filename: string; contentType: string };
      }) => {
        assert.deepEqual(options.source.value, Buffer.from(bytes));
        assert.ok(options.source.filename);
        uploaded.push(kind);
        return { toString: () => kind + "1_2" };
      },
    );
  let raw: Record<string, unknown> = {
    type: "photo",
    photo: {
      sizes: [
        { width: 1, height: 1, url: "https://sun.userapi.com/photo.jpg" },
      ],
    },
  };
  let unknownBefore = false;
  let external = false;
  let vkError = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      if (new URL(String(url)).hostname === "sun.userapi.com")
        return new Response(bytes, {
          headers: {
            "content-type": String(url).endsWith(".jpg")
              ? "image/jpeg"
              : String(url).endsWith(".mp3")
                ? "audio/mpeg"
                : "video/mp4",
          },
        });
      const method = String(url).split("/").at(-1);
      if (method === "users.get")
        return Response.json({ response: [{ id: 42 }] });
      if (method === "messages.getLongPollServer")
        return new Promise<Response>((_, reject) =>
          options!.signal!.addEventListener(
            "abort",
            () => reject(Error("aborted")),
            { once: true },
          ),
        );
      if (method === "messages.send" && vkError)
        throw Error("SECRET SDK ERROR");
      if (method === "messages.send")
        return Response.json({ response: [{ conversation_message_id: 8 }] });
      if (method === "messages.getByConversationMessageId")
        return Response.json({
          response: {
            items: [
              {
                id: 9,
                conversation_message_id: 7,
                peer_id: 42,
                from_id: 43,
                date: 1700000000,
                attachments: unknownBefore ? [{ type: "unknown" }, raw] : [raw],
              },
            ],
          },
        });
      if (method === "messages.getHistory")
        return Response.json({
          response: {
            items: [
              {
                id: 9,
                conversation_message_id: 7,
                peer_id: 42,
                from_id: 43,
                date: 1700000000,
                attachments: unknownBefore ? [{ type: "unknown" }, raw] : [raw],
              },
            ],
          },
        });
      if (method === "video.get")
        return Response.json({
          response: {
            items: [
              {
                files: external
                  ? undefined
                  : { mp4_360: "https://sun.userapi.com/video.mp4" },
                player: "https://vk.com/video_ext.php",
              },
            ],
          },
        });
      return Response.json({ response: { count: 0, items: [] } });
    },
  );
  const c = context();
  await writeStored(c.storage, "vk/token", { token: "test" });
  const driver = createVkDriver({ accountId: "a" });
  await driver.connect(c);
  try {
    for (const input of inputs)
      assert.deepEqual(await driver.sendMedia!("42", input), {
        externalId: "42:8",
      });
    assert.deepEqual(uploaded, ["photo", "video", "doc"]);
    for (const [kind, body] of [
      [
        "photo",
        {
          sizes: [
            { width: 1, height: 1, url: "https://sun.userapi.com/photo.jpg" },
          ],
        },
      ],
      ["audio", { url: "https://sun.userapi.com/audio.mp3" }],
      ["video", { id: 1, owner_id: 2 }],
    ] as const) {
      raw = { type: kind, [kind]: body };
      const messages = await driver.listMessages!("42");
      const attachment = messages[0]!.attachments[0]!;
      assert.equal(attachment.kind, kind);
      assert.ok(attachment.reference);
      assert.deepEqual(
        (await driver.downloadMedia!(attachment.reference!)).data,
        bytes,
      );
    }
    unknownBefore = true;
    raw = {
      type: "photo",
      photo: {
        id: 123,
        owner_id: 42,
        sizes: [
          { width: 1, height: 1, url: "https://sun.userapi.com/photo.jpg" },
        ],
      },
    };
    const sdkReference = normalizeAttachments(
      [{ type: "photo", id: 123, ownerId: 42 }],
      "42",
      7,
      "a",
    )[0]!.reference!;
    assert.deepEqual((await driver.downloadMedia!(sdkReference)).data, bytes);
    unknownBefore = false;
    raw = { type: "video", video: { id: 1, owner_id: 2 } };
    vkError = true;
    await assert.rejects(
      driver.sendMedia!("42", inputs[0]!),
      (error: Error) => !error.message.includes("SECRET"),
    );
    external = true;
    await assert.rejects(
      driver.downloadMedia!(
        encodeMediaReference("vk", "a", {
          chatId: "42",
          conversationMessageId: 7,
          index: 0,
        }),
      ),
      (e: { code: string }) => e.code === "UNSUPPORTED_OPERATION",
    );
  } finally {
    await driver.disconnect();
  }
});

test("WhatsApp preserves protobuf media keys and large lengths, sends buffers and downloads through SDK streams", async () => {
  const ev = new EventEmitter();
  const sends: Record<string, unknown>[] = [];
  let sdkCalls = 0;
  let waError = false;
  const socket = {
    ev,
    end() {},
    async sendMessage(id: string, content: Record<string, unknown>) {
      assert.equal(id, "42@s.whatsapp.net");
      if (waError) throw Error("SECRET SDK ERROR");
      sends.push(content);
      return { key: { id: "sent" } };
    },
    async updateMediaMessage() {},
  };
  const download = (async (raw: proto.IWebMessageInfo, type: string) => {
    sdkCalls++;
    if (waError) throw Error("SECRET SDK ERROR");
    assert.equal(type, "stream");
    const media =
      raw.message?.imageMessage ??
      raw.message?.videoMessage ??
      raw.message?.audioMessage;
    assert.deepEqual(Buffer.from(media!.mediaKey!), Buffer.from(bytes));
    return Readable.from([bytes]);
  }) as unknown as typeof downloadMediaMessage;
  const runtime = new WhatsAppLibraryRuntime(
    "a",
    (() => socket) as unknown as () => WASocket,
    download,
  );
  const opening = runtime.open(context(), true);
  await new Promise((resolve) => setImmediate(resolve));
  ev.emit("connection.update", { connection: "open" });
  await opening;
  try {
    for (const input of inputs)
      assert.deepEqual(await runtime.sendMedia("42@s.whatsapp.net", input), {
        externalId: "42@s.whatsapp.net:sent",
      });
    assert.equal(sends.length, 3);
    assert.ok(sends[0]!.image);
    assert.ok(sends[1]!.video);
    assert.ok(sends[2]!.audio);
    await assert.rejects(
      runtime.sendMedia("42@s.whatsapp.net", {
        ...inputs[2]!,
        caption: "unsupported",
      }),
      (e: { code: string }) => e.code === "UNSUPPORTED_OPERATION",
    );
    assert.equal(sends.length, 3);
    const raw = proto.WebMessageInfo.fromObject({
      key: { remoteJid: "42@s.whatsapp.net", id: "raw" },
      messageTimestamp: 1700000000,
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/encrypted",
          mediaKey: bytes,
          mimetype: "image/jpeg",
          fileLength: "3",
        },
      },
    });
    const attachment = normalizeWhatsApp(raw, "a")!.attachments[0]!;
    assert.equal(attachment.kind, "photo");
    assert.ok(attachment.reference);
    assert.deepEqual(
      (await runtime.downloadMedia(attachment.reference!)).data,
      bytes,
    );
    assert.equal(sdkCalls, 1);
    for (const [type, mimetype] of [
      ["videoMessage", "video/mp4"],
      ["audioMessage", "audio/ogg"],
    ]) {
      const other = proto.WebMessageInfo.fromObject({
        key: { remoteJid: "42@s.whatsapp.net", id: "other" },
        messageTimestamp: 1700000000,
        message: {
          [type!]: {
            url: "https://mmg.whatsapp.net/encrypted",
            mediaKey: bytes,
            mimetype,
            fileLength: "3",
          },
        },
      });
      const ref = normalizeWhatsApp(other, "a")!.attachments[0]!.reference!;
      assert.equal((await runtime.downloadMedia(ref)).mimeType, mimetype);
    }
    assert.equal(sdkCalls, 3);
    const local = proto.WebMessageInfo.fromObject({
      key: { remoteJid: "42@s.whatsapp.net", id: "local" },
      messageTimestamp: 1700000000,
      message: {
        imageMessage: {
          url: "http://127.0.0.1/SECRET",
          mediaKey: bytes,
          mimetype: "image/jpeg",
          fileLength: "3",
        },
      },
    });
    await assert.rejects(
      runtime.downloadMedia(
        normalizeWhatsApp(local, "a")!.attachments[0]!.reference!,
      ),
    );
    assert.equal(sdkCalls, 3);
    waError = true;
    await assert.rejects(
      runtime.sendMedia("42@s.whatsapp.net", inputs[0]!),
      (e: Error) => !e.message.includes("SECRET"),
    );
    await assert.rejects(
      runtime.downloadMedia(attachment.reference!),
      (e: Error) => !e.message.includes("SECRET"),
    );
    assert.equal(sdkCalls, 4);
    waError = false;
    raw.message!.imageMessage!.fileLength =
      proto.Message.ImageMessage.fromObject({
        fileLength: "9007199254740993",
      }).fileLength;
    const large = normalizeWhatsApp(raw, "a")!.attachments[0]!;
    const payload = decodeMediaReference(large.reference!, "whatsapp", "a");
    const restored = proto.WebMessageInfo.decode(
      Buffer.from(payload.message as string, "base64"),
    );
    assert.equal(
      restored.message?.imageMessage?.fileLength?.toString(),
      "9007199254740993",
    );
    await assert.rejects(runtime.downloadMedia(large.reference!));
    assert.equal(sdkCalls, 4);
  } finally {
    await runtime.close();
  }
});

test("Telegram stale media references leave the connected adapter usable", async (t) => {
  t.mock.method(TelegramClient.prototype, "connect", async () => true);
  t.mock.method(
    TelegramClient.prototype,
    "checkAuthorization",
    async () => true,
  );
  t.mock.method(TelegramClient.prototype, "getMe", async () => ({
    bot: false,
  }));
  t.mock.method(TelegramClient.prototype, "destroy", async () => undefined);
  t.mock.method(TelegramClient.prototype, "iterDialogs", async function* () {
    yield { id: bigInt(42), title: "Peer" };
  });
  t.mock.method(TelegramClient.prototype, "sendMessage", async () => ({
    id: 8,
  }));
  let mode = "message-missing";
  t.mock.method(TelegramClient.prototype, "getMessages", async () =>
    mode === "message-missing"
      ? []
      : mode === "attachment-missing"
        ? [
            new Api.Message({
              id: 7,
              peerId: new Api.PeerUser({ userId: bigInt(42) }),
              date: 1700000000,
              message: "Edited",
            }),
          ]
        : [tgPhoto()],
  );
  t.mock.method(TelegramClient.prototype, "downloadMedia", async () => {
    if (mode === "expired")
      throw new FileReferenceExpiredError({ capture: 0, request: undefined });
    if (mode === "sdk-failure") throw Error("SECRET NETWORK ERROR");
    return undefined;
  });
  const c = context();
  await writeStored(c.storage, "telegram/session", { session: "" });
  const driver = createTelegramDriver({
    accountId: "a",
    apiId: 1,
    apiHash: "test",
  });
  const adapter = new Adapter(
    {
      provider: "telegram",
      accountId: "a",
      apiId: 1,
      apiHash: "test",
      storage: c.storage,
    },
    async () => driver,
  );
  const reference = encodeMediaReference("telegram", "a", {
    chatId: "42",
    messageId: "7",
  });
  await adapter.connect();
  try {
    for (mode of [
      "message-missing",
      "attachment-missing",
      "file-missing",
      "expired",
    ]) {
      await assert.rejects(
        adapter.downloadMedia(reference),
        (error: { code: string }) => error.code === "UNSUPPORTED_OPERATION",
      );
      assert.deepEqual(await adapter.listChats(), [
        { id: "42", title: "Peer" },
      ]);
      assert.deepEqual(await adapter.sendMessage("42", "Still connected"), {
        externalId: "42:8",
      });
    }
    mode = "sdk-failure";
    await assert.rejects(
      driver.downloadMedia!(reference),
      (error: { code: string; message: string }) =>
        error.code === "PROVIDER_ERROR" && !error.message.includes("SECRET"),
    );
  } finally {
    await adapter.disconnect();
  }
});

test("VK missing messages and attachments leave the connected adapter usable", async (t) => {
  let mode = "message-missing";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "users.get")
        return Response.json({ response: [{ id: 42 }] });
      if (method === "messages.getLongPollServer")
        return new Promise<Response>((_, reject) =>
          options!.signal!.addEventListener(
            "abort",
            () => reject(Error("aborted")),
            { once: true },
          ),
        );
      if (method === "messages.send")
        return Response.json({ response: [{ conversation_message_id: 8 }] });
      if (method === "messages.getByConversationMessageId") {
        if (mode === "sdk-failure")
          return Response.json({
            error: { error_code: 15, error_msg: "SECRET API ERROR" },
          });
        const attachment =
          mode === "video-missing"
            ? { type: "video" }
            : mode === "file-missing"
              ? { type: "audio", audio: { url: "" } }
              : undefined;
        return Response.json({
          response: {
            items:
              mode === "message-missing"
                ? []
                : [
                    {
                      id: 9,
                      conversation_message_id: 7,
                      peer_id: 42,
                      attachments: attachment ? [attachment] : [],
                    },
                  ],
          },
        });
      }
      return Response.json({ response: { count: 0, items: [] } });
    },
  );
  const c = context();
  await writeStored(c.storage, "vk/token", { token: "test" });
  const driver = createVkDriver({ accountId: "a" });
  const adapter = new Adapter(
    { provider: "vk", accountId: "a", storage: c.storage },
    async () => driver,
  );
  const reference = encodeMediaReference("vk", "a", {
    chatId: "42",
    conversationMessageId: 7,
    index: 0,
  });
  await adapter.connect();
  try {
    for (mode of [
      "message-missing",
      "attachment-missing",
      "video-missing",
      "file-missing",
    ]) {
      await assert.rejects(
        adapter.downloadMedia(reference),
        (error: { code: string }) => error.code === "UNSUPPORTED_OPERATION",
      );
      assert.deepEqual(await adapter.listChats(), []);
      assert.deepEqual(await adapter.sendMessage("42", "Still connected"), {
        externalId: "42:8",
      });
    }
    mode = "sdk-failure";
    await assert.rejects(
      driver.downloadMedia!(reference),
      (error: { code: string; message: string }) =>
        error.code === "PROVIDER_ERROR" && !error.message.includes("SECRET"),
    );
  } finally {
    await adapter.disconnect();
  }
});
