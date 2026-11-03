import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaxDriver } from "../src/providers/max/library.js";
import type { DriverContext } from "../src/library/types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "max-library-"));
  const executable = join(directory, "python");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
let command;
createInterface({input:process.stdin}).on('line', line=>{
 const r=JSON.parse(line);
 if(r.method==='connect' && r.params.accountId==='missing') {process.stdout.write(JSON.stringify({id:r.id,error:'MAX authorization required',code:'AUTH_REQUIRED'})+'\\n');return;}
 if(r.method==='login'||r.method==='connect') {command=r;process.stdout.write(JSON.stringify({event:'storage',requestId:1,method:'writeBatch',changes:[{type:'set',key:'max/session/v1',value:Buffer.from(r.params.accountId).toString('base64')} ]})+'\\n');}
 if(r.method==='storageResult') process.stdout.write(JSON.stringify({id:command.id,...(r.error?{error:'MAX storage failed'}:{result:{ok:true}})})+'\\n');
 if(r.method==='chats') process.stdout.write(JSON.stringify({id:r.id,result:[]})+'\\n');
});
`,
  );
  await chmod(executable, 0o700);
  return {
    executable,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

function context(
  writeBatch: DriverContext["storage"]["writeBatch"],
  signal = new AbortController().signal,
): DriverContext {
  return {
    storage: { read: async () => undefined, writeBatch },
    signal,
    onMessage() {},
    onError() {},
    auth: { qr: async () => {}, challenge: async () => "", progress() {} },
  };
}

test("MAX authorize waits for durable storage ack and isolates accounts", async () => {
  const fake = await fixture();
  const first = createMaxDriver({
    accountId: "one",
    pythonCommand: fake.executable,
  });
  const second = createMaxDriver({
    accountId: "two",
    pythonCommand: fake.executable,
  });
  let release!: () => void;
  const writes: string[] = [];
  const ack = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  try {
    const login = first
      .authorize(
        context(async (changes) => {
          const change = changes[0]!;
          if (change.type === "set")
            writes.push(Buffer.from(change.value).toString());
          await ack;
        }),
      )
      .then(() => {
        completed = true;
      });
    await second.authorize(
      context(async (changes) => {
        const change = changes[0]!;
        if (change.type === "set")
          writes.push(Buffer.from(change.value).toString());
      }),
    );
    assert.equal(completed, false);
    release();
    await login;
    assert.deepEqual(writes.sort(), ["one", "two"]);
  } finally {
    await Promise.all([first.disconnect(), second.disconnect()]);
    await fake.close();
  }
});

test("MAX storage failure rejects login without exposing storage details", async () => {
  const fake = await fixture();
  const driver = createMaxDriver({
    accountId: "one",
    pythonCommand: fake.executable,
  });
  try {
    await assert.rejects(
      driver.authorize(
        context(async () => {
          throw new Error("secret token");
        }),
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  } finally {
    await driver.disconnect();
    await fake.close();
  }
});

test("MAX abort rejects a pending storage login and cleans up child", async () => {
  const fake = await fixture();
  const driver = createMaxDriver({
    accountId: "one",
    pythonCommand: fake.executable,
  });
  const controller = new AbortController();
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const login = driver.authorize(
      context(async () => {
        writeStarted();
        await wait;
      }, controller.signal),
    );
    const rejected = assert.rejects(login);
    await started;
    controller.abort();
    await rejected;
    release();
    await driver.disconnect();
  } finally {
    release?.();
    await driver.disconnect();
    await fake.close();
  }
});

test("MAX reports a storage error code", async () => {
  const fake = await fixture();
  const driver = createMaxDriver({
    accountId: "one",
    pythonCommand: fake.executable,
  });
  try {
    await assert.rejects(
      driver.authorize(
        context(async () => {
          throw new Error("secret");
        }),
      ),
      { code: "STORAGE_ERROR" },
    );
  } finally {
    await driver.disconnect();
    await fake.close();
  }
});

test("MAX preserves AUTH_REQUIRED from worker RPC", async () => {
  const fake = await fixture();
  const driver = createMaxDriver({
    accountId: "missing",
    pythonCommand: fake.executable,
  });
  try {
    await assert.rejects(driver.connect(context(async () => {})), {
      code: "AUTH_REQUIRED",
    });
  } finally {
    await driver.disconnect();
    await fake.close();
  }
});
