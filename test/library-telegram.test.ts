import assert from "node:assert/strict";
import { test } from "node:test";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { AuthFlow } from "../src/library/auth.js";
import { readStored, writeStored } from "../src/library/storage.js";
import { createTelegramDriver } from "../src/providers/telegram/library.js";
import type { DriverContext, SessionStorage } from "../src/library/types.js";

function fixture() {
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
  const context: DriverContext = {
    storage,
    signal: new AbortController().signal,
    onMessage() {},
    onError() {},
  };
  const driver = createTelegramDriver({
    accountId: "one",
    apiId: 123,
    apiHash: "hash",
  });
  return { entries, storage, context, driver };
}

test("Telegram restore refuses missing session without connecting or requesting QR", async (t) => {
  let connects = 0;
  t.mock.method(TelegramClient.prototype, "connect", async () => {
    connects++;
  });
  const f = fixture();
  await assert.rejects(f.driver.connect(f.context), /сесси/i);
  assert.equal(connects, 0);
});

test("Telegram QR authorization forwards QR and 2FA then persists before success", async (t) => {
  const f = fixture();
  let authorized = false;
  let destroyed = 0;
  t.mock.method(TelegramClient.prototype, "connect", async () => true);
  t.mock.method(
    TelegramClient.prototype,
    "checkAuthorization",
    async () => authorized,
  );
  t.mock.method(TelegramClient.prototype, "getMe", async () => ({
    bot: false,
  }));
  t.mock.method(TelegramClient.prototype, "destroy", async () => {
    destroyed++;
  });
  t.mock.method(
    TelegramClient.prototype,
    "signInUserWithQrCode",
    async (
      _credentials: unknown,
      options: Parameters<TelegramClient["signInUserWithQrCode"]>[1],
    ) => {
      await options.qrCode!({
        token: Buffer.from("token"),
        expires: 1700000000,
      });
      assert.equal(await options.password!(), "password");
      authorized = true;
    },
  );
  const qrs: string[] = [];
  f.context.auth = {
    async qr(value) {
      qrs.push(value);
    },
    async challenge(options) {
      assert.equal(options.kind, "password");
      return "password";
    },
    progress() {},
  };
  await f.driver.authorize(f.context);
  assert.equal(qrs[0], "tg://login?token=dG9rZW4");
  assert.ok(f.entries.has("telegram/session"));
  await f.driver.disconnect();
  assert.equal(destroyed, 1);
});

test("Telegram failed session persistence closes the client and fails authorization", async (t) => {
  const f = fixture();
  let destroyed = false;
  t.mock.method(TelegramClient.prototype, "connect", async () => true);
  t.mock.method(
    TelegramClient.prototype,
    "checkAuthorization",
    async () => true,
  );
  t.mock.method(TelegramClient.prototype, "getMe", async () => ({
    bot: false,
  }));
  t.mock.method(TelegramClient.prototype, "destroy", async () => {
    destroyed = true;
  });
  f.storage.writeBatch = async () => {
    throw new Error("storage offline");
  };
  f.context.auth = {
    async qr() {},
    async challenge() {
      return "";
    },
    progress() {},
  };
  await assert.rejects(f.driver.authorize(f.context), /storage offline/);
  assert.equal(destroyed, true);
});

test("Telegram restores saved session and persists SDK session changes before disconnect resolves", async (t) => {
  const f = fixture();
  await writeStored(f.storage, "telegram/session", { session: "" });
  let client: TelegramClient | undefined;
  let serialized = "first";
  t.mock.method(
    TelegramClient.prototype,
    "connect",
    async function (this: TelegramClient) {
      client = this;
      return true;
    },
  );
  t.mock.method(
    TelegramClient.prototype,
    "checkAuthorization",
    async () => true,
  );
  t.mock.method(TelegramClient.prototype, "getMe", async () => ({
    bot: false,
  }));
  t.mock.method(TelegramClient.prototype, "destroy", async () => undefined);
  t.mock.method(StringSession.prototype, "save", () => serialized);
  await f.driver.connect(f.context);
  assert.deepEqual(await readStored(f.storage, "telegram/session"), {
    session: "first",
  });
  serialized = "updated";
  assert.ok(client);
  client.session.save();
  await f.driver.disconnect();
  assert.deepEqual(await readStored(f.storage, "telegram/session"), {
    session: "updated",
  });
});

test("Telegram cancellation rejects a pending 2FA challenge and closes its client", async (t) => {
  const f = fixture();
  const control = new AbortController();
  f.context.signal = control.signal;
  let destroyed = false;
  let asked: () => void = () => undefined;
  const challengeRequested = new Promise<void>((resolve) => {
    asked = resolve;
  });
  f.context.auth = new AuthFlow((event) => {
    if (event.type === "challenge") asked();
  }, control.signal);
  t.mock.method(TelegramClient.prototype, "connect", async () => true);
  t.mock.method(
    TelegramClient.prototype,
    "checkAuthorization",
    async () => false,
  );
  t.mock.method(TelegramClient.prototype, "destroy", async () => {
    destroyed = true;
  });
  t.mock.method(
    TelegramClient.prototype,
    "signInUserWithQrCode",
    async (
      _credentials: unknown,
      options: Parameters<TelegramClient["signInUserWithQrCode"]>[1],
    ) => {
      await options.password!();
    },
  );
  const authorizing = f.driver.authorize(f.context);
  await challengeRequested;
  control.abort();
  await assert.rejects(authorizing, /отменена/);
  assert.equal(destroyed, true);
  assert.equal(f.entries.size, 0);
});

test("Telegram history restores a private channel entity before requesting messages", async (t) => {
  const f = fixture();
  await writeStored(f.storage, "telegram/session", { session: "" });
  const channel = new Api.Channel({
    id: bigInt(42),
    accessHash: bigInt(98765),
    title: "Private",
    photo: new Api.ChatPhotoEmpty(),
    date: 1700000000,
  });
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
  t.mock.method(
    TelegramClient.prototype,
    "iterDialogs",
    async function* (this: TelegramClient) {
      this._entityCache.add([channel]);
      yield { id: bigInt("-10042"), title: "Private" };
    },
  );
  t.mock.method(
    TelegramClient.prototype,
    "invoke",
    async (request: unknown) => {
      assert.ok(request instanceof Api.messages.GetHistory);
      assert.ok(
        request.peer instanceof Api.InputPeerChannel,
        JSON.stringify(request.peer),
      );
      assert.equal(request.peer.accessHash.toString(), "98765");
      return new Api.messages.Messages({
        messages: [
          new Api.Message({
            id: 7,
            peerId: new Api.PeerChannel({ channelId: bigInt(42) }),
            date: 1700000000,
            message: "Saved history",
            out: true,
          }),
        ],
        topics: [],
        chats: [channel],
        users: [],
      });
    },
  );
  try {
    await f.driver.connect(f.context);
    const messages = await f.driver.listMessages!("-10042", { limit: 10 });
    assert.equal(messages[0]?.text, "Saved history");
    assert.equal(messages[0]?.messageId, "-10042:7");
    assert.equal(messages[0]?.direction, "outgoing");
  } finally {
    await f.driver.disconnect();
  }
});
