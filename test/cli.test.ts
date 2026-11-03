import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" },
      timeout: 10_000,
    },
  );
}

test("help is available without credentials or connecting to Telegram", () => {
  const result = cli("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /login/);
  assert.equal(result.stderr, "");
});

test("unsupported provider fails before trying Telegram authorization", () => {
  const result = cli("login", "--provider=unknown");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown пока не реализован/);
  assert.equal(result.stdout, "");
});

test("missing credentials produce a clear failure without network access", () => {
  const result = cli("login");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TELEGRAM_API_ID/);
  assert.equal(result.stdout, "");
});

test("send requires a destination and text before connecting", () => {
  const result = cli("send", "--text=hello");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--chat/);
});

test("QR login accepts the flag and still requires API credentials", () => {
  const result = cli("login", "--qr");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TELEGRAM_API_ID/);
});

test("QR flag is rejected for commands other than login", () => {
  const result = cli("chats", "--qr");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /только для login/);
});

test("VK reports a missing personal session without requiring Telegram credentials", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "chats", "--provider=vk"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        VK_ACCESS_TOKEN: "",
        VK_SESSION_FILE: "/nonexistent/chat-adapter-test/vk.json",
        TELEGRAM_API_ID: "",
        TELEGRAM_API_HASH: "",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Нет сессии VK/);
  assert.equal(result.stdout, "");
});
