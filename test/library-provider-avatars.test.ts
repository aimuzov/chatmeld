import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaxDriver } from "../src/providers/max/library.js";
import { EventEmitter } from "node:events";
import { TelegramClient } from "teleproto";
import type makeWASocket from "@whiskeysockets/baileys";
import { createTelegramDriver } from "../src/providers/telegram/library.js";
import { createVkDriver } from "../src/providers/vk/library.js";
import { WhatsAppLibraryRuntime } from "../src/providers/whatsapp/library-runtime.js";
import { writeStored } from "../src/library/storage.js";
import type { DriverContext } from "../src/library/types.js";

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
function context(): DriverContext {
  const data = new Map<string, Uint8Array>();
  return {
    storage: {
      read: async (key) => data.get(key),
      async writeBatch(changes) {
        for (const change of changes)
          if (change.type === "set") data.set(change.key, change.value);
          else data.delete(change.key);
      },
    },
    signal: new AbortController().signal,
    onMessage() {},
    onError() {},
  };
}

test("Telegram avatar warms restored entities, requests small photo and treats empty bytes as absent", async (t) => {
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
  let warmed = false;
  t.mock.method(TelegramClient.prototype, "iterDialogs", async function* () {
    warmed = true;
    yield { id: 42, title: "Peer" };
  });
  let photo = png;
  t.mock.method(
    TelegramClient.prototype,
    "downloadProfilePhoto",
    async (id: string, options: { isBig: boolean }) => {
      assert.equal(warmed, true);
      assert.equal(id, "42");
      assert.equal(options.isBig, false);
      return photo;
    },
  );
  const c = context();
  await writeStored(c.storage, "telegram/session", { session: "" });
  const driver = createTelegramDriver({
    accountId: "one",
    apiId: 1,
    apiHash: "test",
  });
  await driver.connect(c);
  try {
    const avatar = await driver.getAvatar!({ type: "chat", id: "42" });
    assert.equal(avatar?.mimeType, "image/png");
    assert.deepEqual(Buffer.from(avatar!.data), png);
    photo = Buffer.alloc(0);
    assert.equal(
      await driver.getAvatar!({ type: "user", id: "42" }),
      undefined,
    );
  } finally {
    await driver.disconnect();
  }
});

test("VK avatar uses users, groups and the group conversation's own photo", async (t) => {
  const calls: string[] = [];
  let groupPhoto: string | undefined = "https://sun.vkuserphoto.ru/group.png";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const name = String(url).split("/").at(-1)!;
      if (String(url).startsWith("https://sun.vkuserphoto.ru/")) {
        calls.push(name);
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      const body = options!.body as URLSearchParams;
      if (name === "users.get") {
        if (body.has("user_ids")) {
          assert.equal(body.get("user_ids"), "42");
          assert.equal(body.get("fields"), "photo_100");
        }
        return Response.json({
          response: [
            { id: 42, photo_100: "https://sun.vkuserphoto.ru/user.png" },
          ],
        });
      }
      if (name === "groups.getById") {
        assert.equal(body.get("group_ids"), "7");
        return Response.json({
          response: {
            groups: [
              { id: 7, photo_100: "https://sun.vkuserphoto.ru/community.png" },
            ],
          },
        });
      }
      if (name === "messages.getConversationsById") {
        assert.equal(body.get("peer_ids"), "2000000001");
        return Response.json({
          response: {
            items: [
              {
                peer: { id: 2000000001 },
                chat_settings: {
                  photo: groupPhoto ? { photo_100: groupPhoto } : undefined,
                },
              },
            ],
          },
        });
      }
      if (name === "messages.getLongPollServer")
        return new Promise<Response>((_, reject) =>
          options!.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        );
      return Response.json({ response: { count: 0, items: [] } });
    },
  );
  const c = context();
  await writeStored(c.storage, "vk/token", { token: "test" });
  const driver = createVkDriver({ accountId: "one" });
  await driver.connect(c);
  try {
    for (const target of [
      { type: "user" as const, id: "42" },
      { type: "chat" as const, id: "-7" },
      { type: "chat" as const, id: "2000000001" },
    ])
      assert.equal((await driver.getAvatar!(target))?.mimeType, "image/png");
    groupPhoto = undefined;
    assert.equal(
      await driver.getAvatar!({ type: "chat", id: "2000000001" }),
      undefined,
    );
    assert.deepEqual(calls, ["user.png", "community.png", "group.png"]);
  } finally {
    await driver.disconnect();
  }
});

test("WhatsApp avatar uses preview, maps missing photo and sanitizes SDK errors", async () => {
  const ev = new EventEmitter();
  let mode = 0;
  const runtime = new WhatsAppLibraryRuntime("one", (() => ({
    ev,
    end() {},
    async profilePictureUrl(id: string, size: string) {
      assert.equal(id, "42@s.whatsapp.net");
      assert.equal(size, "preview");
      if (mode) throw { output: { statusCode: mode }, message: "SECRET" };
      return "https://pps.whatsapp.net/avatar";
    },
  })) as unknown as typeof makeWASocket);
  const opening = runtime.open(context(), true);
  await new Promise((resolve) => setImmediate(resolve));
  ev.emit("connection.update", { connection: "open" });
  await opening;
  try {
    assert.equal(
      await runtime.avatarUrl({ type: "user", id: "42@s.whatsapp.net" }),
      "https://pps.whatsapp.net/avatar",
    );
    mode = 404;
    assert.equal(
      await runtime.avatarUrl({ type: "user", id: "42@s.whatsapp.net" }),
      undefined,
    );
    mode = 410;
    assert.equal(
      await runtime.avatarUrl({ type: "user", id: "42@s.whatsapp.net" }),
      undefined,
    );
    mode = 500;
    await assert.rejects(
      runtime.avatarUrl({ type: "user", id: "42@s.whatsapp.net" }),
      (error: Error) => !error.message.includes("SECRET"),
    );
  } finally {
    await runtime.close();
  }
});

test("MAX driver resolves avatar through bridge and downloads only its provider CDN", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "max-avatar-"));
  const executable = join(directory, "python");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 const result=r.method==='avatar'?(r.params.id==='42'?'https://i.oneme.ru/i?r=peer':null):{ok:true};
 process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});
`,
  );
  await chmod(executable, 0o700);
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.href, "https://i.oneme.ru/i?r=peer");
    fetched++;
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const driver = createMaxDriver({
    accountId: "one",
    pythonCommand: executable,
  });
  try {
    await driver.connect(context());
    assert.equal(
      (await driver.getAvatar!({ type: "user", id: "42" }))?.mimeType,
      "image/png",
    );
    assert.equal(
      await driver.getAvatar!({ type: "chat", id: "-7" }),
      undefined,
    );
    assert.equal(fetched, 1);
  } finally {
    await driver.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
