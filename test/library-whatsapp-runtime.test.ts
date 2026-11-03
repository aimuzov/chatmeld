import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type makeWASocket from "@whiskeysockets/baileys";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { AdapterError } from "../src/library/errors.js";
import type { DriverContext, SessionChange } from "../src/library/types.js";
import { WhatsAppLibraryRuntime } from "../src/providers/whatsapp/library-runtime.js";

function harness(
  writeBatch: (changes: readonly SessionChange[]) => Promise<void>,
) {
  const events = new EventEmitter();
  let ended = false;
  const socket = {
    ev: events,
    end() {
      ended = true;
    },
  };
  const runtime = new WhatsAppLibraryRuntime(
    "account",
    (() => socket) as unknown as typeof makeWASocket,
  );
  const errors: Error[] = [];
  const context: DriverContext = {
    storage: {
      async read() {
        return undefined;
      },
      writeBatch,
    },
    signal: new AbortController().signal,
    auth: {
      async qr() {},
      async challenge() {
        return "";
      },
      progress() {},
    },
    onMessage() {},
    onError(error) {
      errors.push(error);
    },
  };
  return { events, runtime, context, errors, ended: () => ended };
}

test("WhatsApp authorization waits for durable credential acknowledgement", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = harness(async () => {
    await gate;
  });
  let opened = false;
  const opening = app.runtime.open(app.context, true).then(() => {
    opened = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  app.events.emit("creds.update", { me: { id: "123@s.whatsapp.net" } });
  app.events.emit("connection.update", { connection: "open" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, false);
  release();
  await opening;
  assert.equal(opened, true);
  await app.runtime.close();
});

test("WhatsApp credential rejection closes the connection and rejects authorization", async () => {
  const app = harness(async () => {
    throw new Error("SECRET");
  });
  const opening = app.runtime.open(app.context, true);
  const rejected = assert.rejects(opening, /хранилищ/);
  await new Promise((resolve) => setImmediate(resolve));
  app.events.emit("creds.update", { me: { id: "123@s.whatsapp.net" } });
  app.events.emit("connection.update", { connection: "open" });
  await rejected;
  assert.equal(app.ended(), true);
  assert.equal(app.errors.length, 1);
  assert.doesNotMatch(app.errors[0]!.message, /SECRET/);
  await assert.rejects(app.runtime.close(), /хранилищ/);
});

test("WhatsApp revoked session requires a new authorization without exposing disconnect details", async () => {
  const app = harness(async () => {});
  const opening = app.runtime.open(app.context, true);
  const rejected = assert.rejects(
    opening,
    (error: Error) =>
      error instanceof AdapterError &&
      error.code === "AUTH_REQUIRED" &&
      !error.message.includes("SECRET"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  app.events.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: {
        message: "SECRET",
        output: { statusCode: DisconnectReason.loggedOut },
      },
    },
  });
  await rejected;
  assert.equal(app.ended(), true);
  assert.equal((app.errors[0] as AdapterError).code, "AUTH_REQUIRED");
  await app.runtime.close();
});
