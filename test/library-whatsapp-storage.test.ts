import assert from "node:assert/strict";
import test from "node:test";
import { proto } from "@whiskeysockets/baileys";
import { createWhatsAppAuthState } from "../src/providers/whatsapp/session-storage.js";
import type { SessionChange, SessionStorage } from "../src/library/types.js";

function memory() {
  const values = new Map<string, Uint8Array>();
  const batches: (readonly SessionChange[])[] = [];
  const storage: SessionStorage = {
    async read(key) {
      return values.get(key);
    },
    async writeBatch(changes) {
      batches.push(changes);
      for (const change of changes)
        if (change.type === "set") values.set(change.key, change.value);
        else values.delete(change.key);
    },
  };
  return { storage, values, batches };
}

test("WhatsApp credentials and Signal keys round-trip binary data through storage", async () => {
  const { storage, batches } = memory();
  const auth = await createWhatsAppAuthState(storage);
  auth.state.creds.me = { id: "123@s.whatsapp.net", name: "User" };
  await auth.saveCreds();
  await auth.state.keys.set({
    session: { a: Buffer.from([0, 255]) },
    "pre-key": { b: { public: Buffer.from([1]), private: Buffer.from([2]) } },
  });
  assert.equal(batches.at(-1)?.length, 2);
  const restored = await createWhatsAppAuthState(storage);
  assert.deepEqual(restored.state.creds.noiseKey, auth.state.creds.noiseKey);
  assert.equal(restored.state.creds.me?.id, "123@s.whatsapp.net");
  assert.deepEqual(
    (await restored.state.keys.get("session", ["a"])).a,
    Buffer.from([0, 255]),
  );
  await restored.state.keys.set({ session: { a: null } });
  assert.equal((await restored.state.keys.get("session", ["a"])).a, undefined);
});

test("WhatsApp app state protobuf is restored", async () => {
  const { storage } = memory();
  const auth = await createWhatsAppAuthState(storage);
  await auth.state.keys.set({
    "app-state-sync-key": {
      key: {
        keyData: Buffer.from([1, 2]),
        fingerprint: { rawId: 12 },
        timestamp: 123,
      },
    },
  });
  const value = (await auth.state.keys.get("app-state-sync-key", ["key"])).key;
  assert.ok(value instanceof proto.Message.AppStateSyncKeyData);
  assert.deepEqual(value?.keyData, Buffer.from([1, 2]));
});

test("WhatsApp storage errors fail closed and never become fresh sessions", async () => {
  await assert.rejects(
    createWhatsAppAuthState({
      async read() {
        throw new Error("secret");
      },
      async writeBatch() {},
    }),
    /хранилищ/,
  );
  let writes = 0;
  const { storage } = memory();
  const auth = await createWhatsAppAuthState({
    read: storage.read,
    async writeBatch() {
      writes++;
      throw new Error("secret");
    },
  });
  await assert.rejects(
    Promise.resolve(auth.state.keys.set({ session: { a: Buffer.from([1]) } })),
    /хранилищ/,
  );
  await assert.rejects(auth.saveCreds(), /хранилищ/);
  assert.equal(writes, 1);
});

test("WhatsApp serializes writes and credentials snapshots", async () => {
  const { storage, batches } = memory();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const auth = await createWhatsAppAuthState({
    read: storage.read,
    async writeBatch(changes) {
      await gate;
      await storage.writeBatch(changes);
    },
  });
  auth.state.creds.nextPreKeyId = 3;
  const first = auth.saveCreds();
  auth.state.creds.nextPreKeyId = 4;
  const second = auth.saveCreds();
  release();
  await Promise.all([first, second]);
  const snapshots = batches.map(
    (batch) =>
      JSON.parse(
        Buffer.from((batch[0] as { value: Uint8Array }).value).toString(),
      ).data.nextPreKeyId,
  );
  assert.deepEqual(snapshots, [3, 4]);
});
