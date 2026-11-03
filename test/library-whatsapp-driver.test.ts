import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { createWhatsAppDriver } from "../src/providers/whatsapp/library.js";
import type { DriverContext } from "../src/library/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AdapterError } from "../src/library/errors.js";

const context = (): DriverContext => ({
  storage: {
    async read() {
      return undefined;
    },
    async writeBatch() {},
  },
  signal: new AbortController().signal,
  onMessage() {},
  onError() {},
});

test("WhatsApp library restores only existing sessions without starting QR", async () => {
  const driver = createWhatsAppDriver({ accountId: "test" });
  try {
    await assert.rejects(
      driver.connect(context()),
      (error: Error) =>
        error instanceof AdapterError && error.code === "AUTH_REQUIRED",
    );
  } finally {
    await driver.disconnect();
  }
});

test("WhatsApp worker propagates storage rejection without exposing values", async () => {
  const driver = createWhatsAppDriver({ accountId: "test" });
  const ctx = context();
  ctx.storage.read = async () => {
    throw new Error("SUPERSECRET");
  };
  try {
    await assert.rejects(
      driver.connect(ctx),
      (error: Error) =>
        error instanceof AdapterError &&
        error.code === "STORAGE_ERROR" &&
        !error.message.includes("SUPERSECRET"),
    );
  } finally {
    await driver.disconnect();
  }
});

test("WhatsApp worker classifies corrupted session data without exposing its content", async () => {
  const driver = createWhatsAppDriver({ accountId: "test" });
  const ctx = context();
  const errors: Error[] = [];
  ctx.onError = (error) => errors.push(error);
  ctx.storage.read = async () => Buffer.from("SUPERSECRET invalid JSON");
  try {
    await assert.rejects(
      driver.connect(ctx),
      (error: Error) =>
        error instanceof AdapterError &&
        error.code === "STORAGE_ERROR" &&
        !error.message.includes("SUPERSECRET"),
    );
    assert.equal((errors[0] as AdapterError).code, "STORAGE_ERROR");
  } finally {
    await driver.disconnect();
  }
});

test("WhatsApp library source has no session filesystem or interactive dependencies", async () => {
  for (const name of [
    "library.ts",
    "library-runtime.ts",
    "library-worker.ts",
    "session-storage.ts",
  ])
    assert.doesNotMatch(
      await readFile(
        new URL(`../src/providers/whatsapp/${name}`, import.meta.url),
        "utf8",
      ),
      /node:fs|useMultiFileAuthState|SIGINT|SIGTERM|console\.|inquirer|provider\.js["']/,
    );
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-no-files-"));
  const moduleUrl = new URL(
    "../src/providers/whatsapp/library.ts",
    import.meta.url,
  ).href;
  const script = `
    const {createWhatsAppDriver}=await import(${JSON.stringify(moduleUrl)});
    const driver=createWhatsAppDriver({accountId:"isolated"});
    try {
      await driver.connect({storage:{read:async()=>undefined,writeBatch:async()=>{}},signal:new AbortController().signal,onMessage(){},onError(){}});
      throw Error("Missing authorization should fail");
    } catch(error) {if(error.code!=="AUTH_REQUIRED")throw error;}
    finally {await driver.disconnect();}
  `;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--import",
        import.meta.resolve("tsx"),
        "-e",
        script,
      ],
      { cwd: directory, timeout: 15000 },
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
