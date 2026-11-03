import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadAvatar, inferAvatar } from "../src/library/avatar.js";
import {
  collectMedia,
  downloadMediaUrl,
  MAX_MEDIA_BYTES,
} from "../src/library/media.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test("avatar downloads infer image type and refuse redirects outside provider CDN", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    calls.push(url.href);
    if (url.pathname === "/redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      });
    return new Response(png, { headers: { "content-type": "text/plain" } });
  });
  const avatar = await downloadAvatar("https://cdn.example.com/photo", [
    "example.com",
  ]);
  assert.equal(avatar?.mimeType, "image/png");
  assert.deepEqual(avatar?.data, png);
  await assert.rejects(
    downloadAvatar("https://cdn.example.com/redirect", ["example.com"]),
    { code: "PROVIDER_ERROR" },
  );
  assert.equal(calls.length, 2);
  await assert.rejects(
    downloadAvatar("http://cdn.example.com/photo", ["example.com"]),
    { code: "PROVIDER_ERROR" },
  );
  assert.equal(calls.length, 2);
});

test("avatar missing photo is undefined; invalid or oversized image is rejected", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 404 }),
  );
  assert.equal(
    await downloadAvatar("https://cdn.example.com/missing", ["example.com"]),
    undefined,
  );
  assert.throws(
    () =>
      inferAvatar(
        new TextEncoder().encode("<svg><script>secret</script></svg>"),
      ),
    { code: "PROVIDER_ERROR" },
  );
  assert.throws(() => inferAvatar(new Uint8Array(256 * 1024 + 1)), {
    code: "PROVIDER_ERROR",
  });
});

test("media download is bounded while streaming and cancels the producer", async () => {
  let closed = false;
  async function* chunks() {
    try {
      yield new Uint8Array(MAX_MEDIA_BYTES);
      yield new Uint8Array(1);
    } finally {
      closed = true;
    }
  }
  await assert.rejects(collectMedia(chunks(), "video/mp4"), {
    code: "UNSUPPORTED_OPERATION",
  });
  assert.equal(closed, true);
});

test("media redirects retain provider restrictions and never expose signed URLs in errors", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://localhost/SECRET?token=private" },
    });
  });
  await assert.rejects(
    downloadMediaUrl("https://cdn.example.com/audio?signature=secret", [
      "example.com",
    ]),
    (error) => {
      assert.doesNotMatch(String(error), /SECRET|private|signature/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("media MIME override never turns a player HTML page into a video file", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>player</html>", {
        headers: { "content-type": "text/html" },
      }),
  );
  await assert.rejects(
    downloadMediaUrl("https://cdn.example.com/video", ["example.com"], {
      mimeType: "video/mp4",
    }),
    { code: "PROVIDER_ERROR" },
  );
});

test("media returns actual CDN image MIME rather than guessed attachment type", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(png, { headers: { "content-type": "image/png" } }),
  );
  const result = await downloadMediaUrl(
    "https://cdn.example.com/photo",
    ["example.com"],
    { mimeType: "image/jpeg" },
  );
  assert.equal(result.mimeType, "image/png");
});

test("oversized provider media is unsupported without starting a download", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(new Uint8Array([1]), {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(MAX_MEDIA_BYTES + 1),
        },
      }),
  );
  await assert.rejects(
    downloadMediaUrl("https://cdn.example.com/large", ["example.com"]),
    { code: "UNSUPPORTED_OPERATION" },
  );
});

test("deleted provider media is unavailable without a connection error", async (t) => {
  for (const status of [404, 410]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status }),
    );
    await assert.rejects(
      downloadMediaUrl("https://cdn.example.com/deleted", ["example.com"]),
      { code: "UNSUPPORTED_OPERATION" },
    );
  }
});
