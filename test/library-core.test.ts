import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthFlow } from "../src/library/auth.js";
import {
  SerializedStorage,
  MemorySessionStorage,
  readStored,
  writeStored,
} from "../src/library/storage.js";
import { Adapter } from "../src/library/adapter.js";
import { createAdapter } from "../src/index.js";
import type {
  AuthEvent,
  DriverContext,
  ProviderDriver,
  Message,
} from "../src/library/types.js";

test("auth challenge exists before delivery, validates a reply, and accepts it only once", async () => {
  let id = "";
  const events: AuthEvent[] = [];
  const flow = new AuthFlow(async (event) => {
    events.push(event);
    if (event.type === "challenge") id = event.challengeId;
  }, new AbortController().signal);
  const waiting = flow.challenge({
    kind: "code",
    prompt: "Код",
    pattern: "^\\d{6}$",
  });
  await Promise.resolve();
  assert.throws(() => flow.respond({ challengeId: id, value: "bad" }), {
    code: "INVALID_RESPONSE",
  });
  flow.respond({ challengeId: id, value: "012345" });
  assert.equal(await waiting, "012345");
  assert.throws(() => flow.respond({ challengeId: id, value: "012345" }), {
    code: "INVALID_CHALLENGE",
  });
  assert.equal(events.length, 1);
});

test("auth supports immediate replies and rejects foreign or cancelled challenges", async () => {
  const control = new AbortController();
  const flow = new AuthFlow((event) => {
    if (event.type === "challenge")
      flow.respond({ challengeId: event.challengeId, value: "secret" });
  }, control.signal);
  assert.equal(
    await flow.challenge({ kind: "password", prompt: "Пароль" }),
    "secret",
  );
  const other = new AuthFlow(() => {}, control.signal);
  const waiting = other.challenge({ kind: "password", prompt: "Пароль" });
  assert.throws(
    () => flow.respond({ challengeId: "foreign", value: "secret" }),
    { code: "INVALID_CHALLENGE" },
  );
  control.abort();
  await assert.rejects(waiting, { code: "AUTH_CANCELLED" });
});

test("storage serializes batches, copies binary values and propagates a durable failure", async () => {
  const records = new Map<string, Uint8Array>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const storage = new SerializedStorage({
    read: async (key) => records.get(key),
    writeBatch: async (changes) => {
      if (++writes === 1) await gate;
      for (const change of changes) {
        if (change.type === "set") records.set(change.key, change.value);
        else records.delete(change.key);
      }
    },
  });
  const bytes = new Uint8Array([1, 2]);
  const first = storage.writeBatch([{ type: "set", key: "x", value: bytes }]);
  bytes[0] = 9;
  const second = storage.writeBatch([
    { type: "set", key: "y", value: new Uint8Array([3]) },
  ]);
  await Promise.resolve();
  assert.equal(writes, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(await storage.read("x"), new Uint8Array([1, 2]));
  const value = await storage.read("x");
  value![0] = 8;
  assert.equal((await storage.read("x"))![0], 1);
  const failed = new SerializedStorage({
    read: async () => {
      throw Error("secret-token");
    },
    writeBatch: async () => {
      throw Error("secret-token");
    },
  });
  await assert.rejects(
    failed.read("x"),
    (error) =>
      (error as Error).message.indexOf("secret-token") === -1 &&
      (error as { code: string }).code === "STORAGE_ERROR",
  );
  await assert.rejects(failed.writeBatch([]), { code: "STORAGE_ERROR" });
});

test("versioned session storage separates absence, corruption and user namespaces", async () => {
  const alice = new MemorySessionStorage();
  const bob = new MemorySessionStorage();
  assert.equal(await readStored(alice, "session"), undefined);
  await writeStored(alice, "session", { token: "alice" });
  assert.deepEqual(await readStored(alice, "session"), { token: "alice" });
  assert.equal(await readStored(bob, "session"), undefined);
  await bob.writeBatch([
    { type: "set", key: "session", value: new TextEncoder().encode("invalid") },
  ]);
  await assert.rejects(readStored(bob, "session"), { code: "STORAGE_ERROR" });
});

function fixture() {
  let context: DriverContext;
  let closes = 0;
  const driver: ProviderDriver = {
    connect: async (value) => {
      context = value;
    },
    authorize: async (value) => {
      context = value;
      const password = await value.auth!.challenge({
        kind: "password",
        prompt: "Пароль",
      });
      await writeStored(value.storage, "session", {
        passwordAccepted: password === "ok",
      });
    },
    listChats: async () => [{ id: "123", title: "Контакт" }],
    sendMessage: async () => ({ externalId: "123:1" }),
    disconnect: async () => {
      closes++;
    },
  };
  const storage = new MemorySessionStorage();
  const adapter = new Adapter(
    { provider: "vk", accountId: "one", storage },
    async () => driver,
  );
  return {
    adapter,
    storage,
    get context() {
      return context!;
    },
    get closes() {
      return closes;
    },
  };
}

test("adapter is lazy, authorizes programmatically and restores through its own scoped store", async () => {
  const f = fixture();
  assert.equal(f.closes, 0);
  await assert.rejects(f.adapter.listChats(), { code: "AUTH_REQUIRED" });
  await f.adapter.authorize({
    onEvent: (event) => {
      if (event.type === "challenge")
        f.adapter.respondToChallenge({
          challengeId: event.challengeId,
          value: "ok",
        });
    },
  });
  assert.deepEqual(await readStored(f.storage, "session"), {
    passwordAccepted: true,
  });
  assert.deepEqual(await f.adapter.listChats(), [
    { id: "123", title: "Контакт" },
  ]);
  await f.adapter.disconnect();
  assert.equal(f.closes, 1);
});

test("adapter cancels a pending challenge without terminating another account", async () => {
  const first = fixture(),
    second = fixture();
  await second.adapter.connect();
  let notified!: () => void;
  const ready = new Promise<void>((resolve) => {
    notified = resolve;
  });
  const login = first.adapter.authorize({ onEvent: () => notified() });
  const rejected = assert.rejects(login, { code: "AUTH_CANCELLED" });
  await ready;
  await assert.rejects(first.adapter.connect(), { code: "INVALID_STATE" });
  await first.adapter.disconnect();
  await rejected;
  assert.equal(first.closes, 1);
  assert.deepEqual(await second.adapter.listChats(), [
    { id: "123", title: "Контакт" },
  ]);
  await second.adapter.disconnect();
});

test("async message handler failures close the adapter without exposing secrets", async () => {
  const f = fixture();
  let failed!: () => void;
  const done = new Promise<void>((resolve) => {
    failed = resolve;
  });
  f.adapter.onState((state) => {
    if (state.state === "error") {
      assert.equal((state.error as { code?: string }).code, "HANDLER_ERROR");
      assert.ok(!state.error.message.includes("private"));
      failed();
    }
  });
  f.adapter.onMessage(async () => {
    throw Error("private");
  });
  await f.adapter.connect();
  f.context.onMessage({
    provider: "vk",
    accountId: "one",
    chatId: "1",
    messageId: "1",
    direction: "incoming",
    text: "hello",
    sentAt: new Date().toISOString(),
    attachments: [],
  } satisfies Message);
  await done;
  await f.adapter.disconnect();
  assert.equal(f.closes, 1);
});

test("disconnect drains the provider before aborting an established connection", async () => {
  let abortedOnClose: boolean | undefined;
  let signal: AbortSignal;
  const driver: ProviderDriver = {
    connect: async (context) => {
      signal = context.signal;
    },
    authorize: async () => {},
    listChats: async () => [],
    sendMessage: async () => ({ externalId: "1" }),
    disconnect: async () => {
      abortedOnClose = signal.aborted;
    },
  };
  const adapter = new Adapter(
    { provider: "vk", accountId: "one", storage: new MemorySessionStorage() },
    async () => driver,
  );
  await adapter.connect();
  await adapter.disconnect();
  assert.equal(abortedOnClose, false);
  assert.equal(signal!.aborted, true);
});

test("a stale async message handler cannot fail a reconnected adapter", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const remove = f.adapter.onMessage(async () => {
    started();
    await gate;
    throw Error("old handler");
  });
  await f.adapter.connect();
  f.context.onMessage({
    provider: "vk",
    accountId: "one",
    chatId: "1",
    messageId: "1",
    direction: "incoming",
    text: "old",
    sentAt: new Date().toISOString(),
    attachments: [],
  });
  await ready;
  await f.adapter.disconnect();
  remove();
  await f.adapter.connect();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await f.adapter.listChats(), [
    { id: "123", title: "Контакт" },
  ]);
  await f.adapter.disconnect();
});

test(
  "cancelling auth releases a challenge even when its event delivery is stalled",
  { timeout: 1000 },
  async () => {
    const control = new AbortController();
    const flow = new AuthFlow(
      () => new Promise<void>(() => {}),
      control.signal,
    );
    const waiting = flow.challenge({ kind: "password", prompt: "Пароль" });
    const rejected = assert.rejects(waiting, { code: "AUTH_CANCELLED" });
    await Promise.resolve();
    control.abort();
    await rejected;
  },
);

test("message backlog is bounded and fails the connection explicitly", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let overflow!: () => void;
  const failed = new Promise<void>((resolve) => {
    overflow = resolve;
  });
  f.adapter.onState((state) => {
    if (state.state === "error") {
      assert.equal((state.error as { code?: string }).code, "QUEUE_OVERFLOW");
      overflow();
    }
  });
  f.adapter.onMessage(() => gate);
  await f.adapter.connect();
  for (let i = 0; i < 101; i++)
    f.context.onMessage({
      provider: "vk",
      accountId: "one",
      chatId: "1",
      messageId: String(i),
      direction: "incoming",
      text: "hello",
      sentAt: new Date().toISOString(),
      attachments: [],
    });
  await failed;
  release();
  await f.adapter.disconnect();
});

test("reconnect is rejected until disconnect has finished closing its driver", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened = 0;
  const driver: ProviderDriver = {
    connect: async () => {
      opened++;
    },
    authorize: async () => {},
    listChats: async () => [],
    sendMessage: async () => ({ externalId: "1" }),
    disconnect: () => gate,
  };
  const adapter = new Adapter(
    { provider: "vk", accountId: "one", storage: new MemorySessionStorage() },
    async () => driver,
  );
  await adapter.connect();
  const closing = adapter.disconnect();
  await assert.rejects(adapter.connect(), { code: "INVALID_STATE" });
  release();
  await closing;
  await adapter.connect();
  assert.equal(opened, 2);
  await adapter.disconnect();
});

test("a stale driver error cannot terminate a replacement connection", async () => {
  const f = fixture();
  await f.adapter.connect();
  const previous = f.context;
  await f.adapter.disconnect();
  await f.adapter.connect();
  previous.onError(Error("old network failure"));
  assert.deepEqual(await f.adapter.listChats(), [
    { id: "123", title: "Контакт" },
  ]);
  await f.adapter.disconnect();
});

test("reconnecting from an error observer waits for driver cleanup", async () => {
  const f = fixture();
  let attempt: Promise<void> | undefined;
  f.adapter.onState((state) => {
    if (state.state === "error") attempt = f.adapter.connect();
  });
  await f.adapter.connect();
  f.context.onError(Error("failure"));
  await assert.rejects(attempt!, { code: "INVALID_STATE" });
  await f.adapter.disconnect();
});

test("messages from a closed driver are not delivered to a replacement connection", async () => {
  const f = fixture();
  let received = 0;
  f.adapter.onMessage(() => {
    received++;
  });
  await f.adapter.connect();
  const previous = f.context;
  await f.adapter.disconnect();
  await f.adapter.connect();
  previous.onMessage({
    provider: "vk",
    accountId: "one",
    chatId: "1",
    messageId: "late",
    direction: "incoming",
    text: "stale",
    sentAt: new Date().toISOString(),
    attachments: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 0);
  await f.adapter.disconnect();
});

test("reusing an options object cannot change an adapter's account or storage", async () => {
  let firstReads = 0,
    secondReads = 0;
  const options = {
    provider: "vk" as const,
    accountId: "first",
    storage: {
      read: async () => {
        firstReads++;
        return undefined;
      },
      writeBatch: async () => {},
    },
  };
  const adapter = createAdapter(options);
  options.accountId = "second";
  options.storage = {
    read: async () => {
      secondReads++;
      return undefined;
    },
    writeBatch: async () => {},
  };
  await assert.rejects(adapter.connect(), { code: "AUTH_REQUIRED" });
  assert.equal(adapter.accountId, "first");
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 0);
  await adapter.disconnect();
});
