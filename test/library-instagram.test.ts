import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdapter, MemorySessionStorage } from "../src/index.js";
import { createInstagramDriver } from "../src/providers/instagram/library.js";
import { readStored } from "../src/library/storage.js";
import { decodeMediaReference } from "../src/library/media.js";
import type { DriverContext } from "../src/library/types.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "instagram-driver-"));
  const executable = join(dir, "python");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require('node:readline');
let login;
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'login') { login = r; emit({event:'challenge',requestId:1,kind:'password',prompt:'Пароль Instagram'}); }
  if (r.method === 'eventResult' && r.requestId === 1) emit({event:'challenge',requestId:2,kind:'code',prompt:'Код Instagram',pattern:'^[0-9]{6}$'});
  if (r.method === 'eventResult' && r.requestId === 2) emit({event:'session',requestId:3,settings:{authorization_data:{ds_user_id:'123'},cookies:{sessionid:login.params.accountId}}});
  if (r.method === 'eventResult' && r.requestId === 3) emit({id:login.id,...(r.error ? {error:'sensitive password token',code:'STORAGE_ERROR'} : {result:{ok:true}})});
  if (r.method === 'connect') emit({id:r.id,result:{ok:true}});
  if (r.method === 'chats') emit({id:r.id,result:[{id:'340282366841710301244276160995837550305',title:'Алексей Иванов'}]});
  if (r.method === 'history') emit({id:r.id,result:r.params.chatId==='43'?[{provider:'instagram',accountId:'a',chatId:'43',messageId:'43:9007199254740993001',direction:'incoming',text:'',sentAt:'2026-11-03T12:00:00Z',attachments:[{kind:'photo',mimeType:'image/jpeg',referencePayload:{chatId:'43',messageId:'9007199254740993001',index:0}}]}]:[]});
  if (r.method === 'sendMedia') emit({id:r.id,result:{externalId:r.params.chatId+':media1'}});
  if (r.method === 'downloadMedia') emit({id:r.id,result:{url:'https://scontent.cdninstagram.com/photo.jpg',mimeType:'image/jpeg'}});
  if (r.method === 'send') emit({id:r.id,result:{externalId:r.params.chatId+':msg1'}});
});
`,
  );
  await chmod(executable, 0o700);
  return { executable, close: () => rm(dir, { recursive: true, force: true }) };
}

function context(storage = new MemorySessionStorage()): DriverContext {
  return {
    storage,
    signal: new AbortController().signal,
    onMessage() {},
    onError() {},
    auth: {
      async qr() {
        throw new Error("Unexpected QR");
      },
      async challenge({ kind }) {
        return kind === "password" ? "private-password" : "123456";
      },
      progress() {},
    },
  };
}

test("Instagram public API validates username and restores only existing sessions", async () => {
  const adapter = createAdapter({
    provider: "instagram",
    accountId: "a",
    username: "example",
    storage: new MemorySessionStorage(),
  });
  assert.equal(adapter.provider, "instagram");
  await assert.rejects(adapter.connect(), { code: "AUTH_REQUIRED" });
  await adapter.disconnect();
  assert.throws(
    () =>
      createAdapter({
        provider: "instagram",
        accountId: "a",
        username: "",
        storage: new MemorySessionStorage(),
      }),
    { code: "INVALID_OPTIONS" },
  );
});

test("Instagram password and 2FA flow waits for durable session storage", async () => {
  const fake = await fixture();
  const driver = createInstagramDriver({
    accountId: "a",
    username: "example",
    pythonCommand: fake.executable,
  });
  const store = new MemorySessionStorage();
  const ctx = context(store);
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const ack = new Promise<void>((r) => (release = r));
  ctx.storage = {
    read: (k) => store.read(k),
    async writeBatch(changes) {
      started();
      await ack;
      await store.writeBatch(changes);
    },
  };
  let done = false;
  try {
    const login = driver.authorize(ctx).then(() => {
      done = true;
    });
    await writing;
    assert.equal(done, false);
    release();
    await login;
    const session = await readStored<Record<string, unknown>>(
      store,
      "instagram/session",
    );
    assert.ok(session);
    assert.doesNotMatch(JSON.stringify(session), /private-password|123456/);
    assert.equal((await driver.listChats())[0]?.title, "Алексей Иванов");
    assert.equal(
      (
        await driver.sendMessage(
          "340282366841710301244276160995837550305",
          "hello",
        )
      ).externalId,
      "340282366841710301244276160995837550305:msg1",
    );
    assert.deepEqual(await driver.listMessages!("42", { limit: 10 }), []);
  } finally {
    release?.();
    await driver.disconnect();
    await fake.close();
  }
});

test("Instagram storage rejection fails login without exposing secrets", async () => {
  const fake = await fixture();
  const driver = createInstagramDriver({
    accountId: "a",
    username: "example",
    pythonCommand: fake.executable,
  });
  const ctx = context();
  ctx.storage.writeBatch = async () => {
    throw new Error("private-password sessionid=SECRET");
  };
  try {
    await assert.rejects(driver.authorize(ctx), (error) => {
      assert.equal((error as { code: string }).code, "STORAGE_ERROR");
      assert.doesNotMatch(String(error), /private-password|SECRET|sensitive/);
      return true;
    });
  } finally {
    await driver.disconnect();
    await fake.close();
  }
});

test("Instagram cancellation releases a waiting password challenge", async () => {
  const fake = await fixture();
  const driver = createInstagramDriver({
    accountId: "a",
    username: "example",
    pythonCommand: fake.executable,
  });
  const ctx = context();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  let asked!: () => void;
  const ready = new Promise<void>((r) => (asked = r));
  ctx.auth!.challenge = async () => {
    asked();
    return new Promise<string>(() => {});
  };
  try {
    const pending = assert.rejects(driver.authorize(ctx), {
      code: "AUTH_CANCELLED",
    });
    await ready;
    controller.abort();
    await pending;
  } finally {
    await driver.disconnect();
    await fake.close();
  }
});

test("Instagram corrupted session is a storage error before starting Python", async () => {
  const ctx = context();
  await ctx.storage.writeBatch([
    {
      type: "set",
      key: "instagram/session",
      value: new TextEncoder().encode("secret"),
    },
  ]);
  const driver = createInstagramDriver({
    accountId: "a",
    username: "example",
    pythonCommand: "/nonexistent",
  });
  await assert.rejects(driver.connect(ctx), { code: "STORAGE_ERROR" });
  await driver.disconnect();
});

test("Instagram null session envelope cannot be mistaken for missing credentials", async () => {
  const ctx = context();
  await ctx.storage.writeBatch([
    {
      type: "set",
      key: "instagram/session",
      value: new TextEncoder().encode(
        JSON.stringify({ version: 1, data: null }),
      ),
    },
  ]);
  const driver = createInstagramDriver({
    accountId: "a",
    username: "example",
    pythonCommand: "/nonexistent",
  });
  await assert.rejects(driver.connect(ctx), { code: "STORAGE_ERROR" });
  await driver.disconnect();
});

test("Instagram Node RPC sends bytes and exposes durable media references", async (t) => {
  const fake = await fixture();
  const driver = createInstagramDriver({
    accountId: "a",
    username: "example",
    pythonCommand: fake.executable,
  });
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
  );
  try {
    await driver.authorize(context());
    const sent = await driver.sendMedia!("43", {
      kind: "photo",
      data: bytes,
      mimeType: "image/jpeg",
    });
    assert.equal(sent.externalId, "43:media1");
    const [message] = await driver.listMessages!("43");
    const attachment = message!.attachments[0]!;
    assert.equal("referencePayload" in attachment, false);
    assert.deepEqual(
      decodeMediaReference(attachment.reference!, "instagram", "a"),
      { chatId: "43", messageId: "9007199254740993001", index: 0 },
    );
    assert.deepEqual(
      (await driver.downloadMedia!(attachment.reference!)).data,
      bytes,
    );
    await assert.rejects(
      driver.downloadMedia!(attachment.reference!.slice(0, -8)),
      { code: "INVALID_OPTIONS" },
    );
  } finally {
    await driver.disconnect();
    await fake.close();
  }
});
