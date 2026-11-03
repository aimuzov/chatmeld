import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sqliteSessionStorage } from "../examples/sqlite-storage.js";
import type { SessionChange } from "../src/index.js";

test("README SQLite storage isolates scopes, copies bytes and applies deletes", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const alice = sqliteSessionStorage(db, "alice/vk/main");
    const bob = sqliteSessionStorage(db, "bob/vk/main");
    assert.equal(await alice.read("session"), undefined);
    await alice.writeBatch([
      { type: "set", key: "session", value: new Uint8Array([1, 2, 3]) },
    ]);
    assert.equal(await bob.read("session"), undefined);
    const bytes = await alice.read("session");
    bytes![0] = 9;
    assert.deepEqual(await alice.read("session"), new Uint8Array([1, 2, 3]));
    await alice.writeBatch([{ type: "delete", key: "session" }]);
    assert.equal(await alice.read("session"), undefined);
  } finally {
    db.close();
  }
});

test("README SQLite storage rolls back the entire failed batch", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = sqliteSessionStorage(db, "owner");
    await store.writeBatch([
      { type: "set", key: "key", value: new Uint8Array([1]) },
    ]);
    await assert.rejects(
      store.writeBatch([
        { type: "set", key: "key", value: new Uint8Array([2]) },
        {
          type: "set",
          key: null,
          value: new Uint8Array([3]),
        } as unknown as SessionChange,
      ]),
    );
    assert.deepEqual(await store.read("key"), new Uint8Array([1]));
    await store.writeBatch([
      { type: "set", key: "later", value: new Uint8Array([4]) },
    ]);
    assert.deepEqual(await store.read("later"), new Uint8Array([4]));
  } finally {
    db.close();
  }
});
