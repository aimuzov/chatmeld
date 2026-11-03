import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VkProvider } from "../src/providers/vk/provider.js";
import type { Message } from "../src/core/provider.js";

async function fixture(
  reply: (method: string, params: URLSearchParams) => unknown,
) {
  const directory = await mkdtemp(join(tmpdir(), "chat-adapter-vk-"));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        reply(req.url!.split("/").at(-1)!, new URLSearchParams(body)),
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const file = join(directory, "private", "vk.json");
  const provider = new VkProvider("personal", {
    sessionFile: file,
    token: "a".repeat(64),
    apiBaseUrl: `http://127.0.0.1:${address.port}/method`,
  });
  await provider.connect();
  return {
    provider,
    file,
    close: async () => {
      await provider.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("VK does not save a token when access to personal messages is denied", async () => {
  const f = await fixture((method) =>
    method === "users.get"
      ? { response: [{ id: 42 }] }
      : {
          error: {
            error_code: 15,
            error_msg: "Access denied",
            request_params: [],
          },
        },
  );
  try {
    await assert.rejects(f.provider.login(), /код 15/);
    await assert.rejects(access(f.file), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("VK saves a private session, paginates named conversations and returns a scoped sent ID", async () => {
  const f = await fixture((method, params) => {
    if (method === "users.get") return { response: [{ id: 42 }] };
    if (method === "messages.send") {
      assert.equal(params.get("peer_ids"), "42");
      assert.equal(params.get("message"), "Привет");
      assert.ok(Number.isInteger(Number(params.get("random_id"))));
      return {
        response: [
          { peer_id: 42, message_id: 99, conversation_message_id: 17 },
        ],
      };
    }
    if (params.get("count") === "1")
      return { response: { count: 201, items: [] } };
    assert.equal(params.get("extended"), "1");
    const offset = Number(params.get("offset"));
    const ids =
      offset === 0
        ? Array.from({ length: 200 }, (_, index) => index + 1)
        : [201];
    return {
      response: {
        count: 201,
        items: ids.map((id) => ({ conversation: { peer: { id } } })),
        profiles: ids.map((id) => ({
          id,
          first_name: "Иван",
          last_name: String(id),
        })),
        groups: [],
      },
    };
  });
  try {
    await f.provider.login();
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    const chats = await f.provider.listChats();
    assert.equal(chats.length, 201);
    assert.deepEqual(chats.at(-1), { id: "201", title: "Иван 201" });
    assert.deepEqual(await f.provider.sendMessage("42", "Привет"), {
      externalId: "42:17",
    });
  } finally {
    await f.close();
  }
});

test("VK processes User Long Poll messages and aborts the waiting request on shutdown", async (t) => {
  const f = await fixture((method) => {
    if (method === "users.get") return { response: [{ id: 42 }] };
    if (method === "messages.getLongPollServer")
      return {
        response: { server: "lp.vk.ru/test", key: "test-key", ts: "100" },
      };
    if (method === "messages.getById")
      return {
        response: {
          items: [
            {
              id: 99,
              conversation_message_id: 17,
              peer_id: 73,
              from_id: 73,
              date: 1700000000,
              text: "Привет",
              out: 0,
              attachments: [],
            },
          ],
        },
      };
    return { response: { count: 0, items: [] } };
  });
  let request = 0;
  let aborted = false;
  const originalFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: URL, options: RequestInit) => {
      if (!String(_url).startsWith("https://lp.vk.ru/"))
        return originalFetch(_url, options);
      if (request++ === 0)
        return Response.json({
          ts: "101",
          updates: [[10004, 17, 0, 0, 73, 1700000000, "Привет", {}, {}, 0, 99]],
        });
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    },
  );
  try {
    await f.provider.requireAuthorization();
    const incoming = new Promise<Message>((resolve) =>
      f.provider.subscribe(resolve),
    );
    const message = await incoming;
    assert.equal(message.messageId, "73:17");
    assert.equal(message.text, "Привет");
    await new Promise((resolve) => setImmediate(resolve));
    await f.provider.disconnect();
    assert.equal(aborted, true);
  } finally {
    await f.close();
  }
});

test(
  "VK restarts polling after unsubscribe and subscribe again",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture((method) => {
      if (method === "users.get") return { response: [{ id: 42 }] };
      if (method === "messages.getLongPollServer")
        return { response: { server: "lp.vk.ru/test", key: "key", ts: "100" } };
      return { response: { count: 0, items: [] } };
    });
    let wake: () => void = () => undefined;
    let requests = 0;
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (url: URL, options: RequestInit) => {
      if (!String(url).startsWith("https://lp.vk.ru/"))
        return originalFetch(url, options);
      requests++;
      wake();
      return new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    try {
      await f.provider.requireAuthorization();
      const first = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = f.provider.subscribe(() => undefined);
      await first;
      const second = new Promise<void>((resolve) => {
        wake = resolve;
      });
      unsubscribe();
      f.provider.subscribe(() => undefined);
      await second;
      assert.equal(requests, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "VK bounds rate limit retries and reports the failure",
  { timeout: 5000 },
  async () => {
    let attempts = 0;
    const f = await fixture((method) => {
      if (method === "users.get") return { response: [{ id: 42 }] };
      if (method === "messages.getLongPollServer") {
        attempts++;
        return { error: { error_code: 6, error_msg: "Too many requests" } };
      }
      return { response: { count: 0, items: [] } };
    });
    try {
      await f.provider.requireAuthorization();
      const failure = new Promise<Error>((resolve) =>
        f.provider.onError(resolve),
      );
      f.provider.subscribe(() => undefined);
      assert.match((await failure).message, /код 6/);
      assert.equal(attempts, 3);
    } finally {
      await f.close();
    }
  },
);

test(
  "VK shutdown cancels rate limit backoff in API requests",
  { timeout: 5000 },
  async () => {
    let request: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      request = resolve;
    });
    let attempts = 0;
    const f = await fixture((method) => {
      if (method === "users.get") return { response: [{ id: 42 }] };
      if (method === "messages.getLongPollServer") {
        attempts++;
        request();
        return { error: { error_code: 6, error_msg: "Too many requests" } };
      }
      return { response: { count: 0, items: [] } };
    });
    try {
      await f.provider.requireAuthorization();
      f.provider.subscribe(() => undefined);
      await received;
      await f.provider.disconnect();
      assert.equal(attempts, 1);
    } finally {
      await f.close();
    }
  },
);
