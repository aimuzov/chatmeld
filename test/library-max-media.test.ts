import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaxDriver } from "../src/providers/max/library.js";
import {
  decodeMediaReference,
  encodeMediaReference,
} from "../src/library/media.js";
import type { DriverContext, Message } from "../src/library/types.js";

async function fixture(accountId = "one", storageFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), "max-media-"));
  const executable = join(directory, "python");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let pending;
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='connect') {out({id:r.id,result:{ok:true}});out({event:'message',message:{provider:'max',accountId:'one',chatId:'-42',messageId:'-42:9007199254740993',direction:'incoming',sentAt:'2023-11-14T22:13:20.000Z',text:'',attachments:[{kind:'photo',referencePayload:{chatId:'-42',messageId:'9007199254740993',index:0}}]}});}
 if(r.method==='sendMedia') {
  if(r.params.chatId==='storage') {pending=r;out({event:'storage',method:'writeBatch',requestId:1,changes:[{type:'set',key:'max/session/v1',value:'eA=='}]});return;}
  out({id:r.id,result:{externalId:r.params.chatId+':'+r.params.media.kind+':'+r.params.media.data+':'+r.params.media.fileName}});
 }
 if(r.method==='storageResult' && pending) out({id:pending.id,...(r.error?{error:'secret'}:{result:{externalId:'stored'}})});
 if(r.method==='downloadMedia') out(r.params.payload.index===99?{id:r.id,error:'secret token',code:'UNSUPPORTED_OPERATION'}:{id:r.id,result:{url:r.params.payload.index===1?'https://evil.invalid/private':'https://i.oneme.ru/photo',mimeType:'image/jpeg',fileName:'photo.jpg'}});
});
`,
  );
  await chmod(executable, 0o700);
  const driver = createMaxDriver({ accountId, pythonCommand: executable });
  let incoming!: (message: Message) => void;
  const message = new Promise<Message>((resolve) => {
    incoming = resolve;
  });
  const context: DriverContext = {
    storage: {
      read: async () => undefined,
      writeBatch: async () => {
        if (storageFailure) throw new Error("secret");
      },
    },
    signal: new AbortController().signal,
    onMessage: incoming,
    onError() {},
  };
  await driver.connect(context);
  return {
    driver,
    message,
    close: async () => {
      await driver.disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("MAX uploads three media kinds as base64 without temporary files", async () => {
  const fake = await fixture();
  try {
    for (const [kind, mimeType, fileName] of [
      ["photo", "image/jpeg", "photo.jpg"],
      ["video", "video/mp4", "video.mp4"],
      ["audio", "audio/mpeg", "audio.mp3"],
    ] as const) {
      assert.deepEqual(
        await fake.driver.sendMedia!("-42", {
          kind,
          data: new Uint8Array([1, 2, 3]),
          mimeType,
          fileName,
        }),
        { externalId: `-42:${kind}:AQID:${fileName}` },
      );
    }
  } finally {
    await fake.close();
  }
});

test("MAX incoming attachment reference preserves full string IDs and removes private payload", async () => {
  const fake = await fixture();
  try {
    const attachment = (await fake.message).attachments[0]!;
    assert.equal("referencePayload" in attachment, false);
    assert.deepEqual(
      decodeMediaReference(attachment.reference!, "max", "one"),
      { chatId: "-42", messageId: "9007199254740993", index: 0 },
    );
  } finally {
    await fake.close();
  }
});

test("MAX downloads only trusted provider URLs and preserves unsupported error", async () => {
  const fake = await fixture();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const ref = (index: number) =>
    encodeMediaReference("max", "one", {
      chatId: "-42",
      messageId: "9007199254740993",
      index,
    });
  try {
    assert.deepEqual(await fake.driver.downloadMedia!(ref(0)), {
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
    });
    await assert.rejects(fake.driver.downloadMedia!(ref(1)), {
      code: "PROVIDER_ERROR",
    });
    assert.deepEqual(urls, ["https://i.oneme.ru/photo"]);
    await assert.rejects(fake.driver.downloadMedia!(ref(99)), {
      code: "UNSUPPORTED_OPERATION",
      message: "MAX request failed",
    });
    await assert.rejects(
      fake.driver.downloadMedia!(encodeMediaReference("max", "two", {})),
      { code: "INVALID_OPTIONS" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fake.close();
  }
});

test("MAX media requests fail when session persistence fails", async () => {
  const fake = await fixture("one", true);
  try {
    await assert.rejects(
      fake.driver.sendMedia!("storage", {
        kind: "photo",
        data: new Uint8Array([1]),
        mimeType: "image/jpeg",
      }),
      { code: "STORAGE_ERROR" },
    );
  } finally {
    await fake.close();
  }
});
