<p align="center">
	<img src="https://img.shields.io/badge/English-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English">
	<a href="README.ru.md"><img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский"></a>
</p>

<p align="center">
  <img src=".github/assets/banner.en.jpg" alt="Chatmeld" width="100%">
</p>

<p align="center">
  <a href="https://github.com/aimuzov/chatmeld/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/chatmeld/check.yml?branch=main&amp;label=check" alt="Check"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D24-5fa04e?logo=nodedotjs&logoColor=white" alt="Node.js &gt;=24"></a>
  <a href="src/index.ts"><img src="https://img.shields.io/badge/TypeScript-ESM-3178c6?logo=typescript&logoColor=white" alt="TypeScript ESM"></a>
  <img src="https://img.shields.io/badge/providers-4-8b5cf6" alt="4 providers">
</p>

<h3 align="center">One API for personal messaging accounts</h3>

# Chatmeld

One TypeScript API for personal Telegram, MAX, WhatsApp and VK accounts.
Connect messaging accounts to your backend, authorize them with QR codes,
send text and receive incoming messages through the same interface.

Your project supplies session storage, message persistence, users and the UI.
Chatmeld runs the messaging connections. It does not create a chat database
or session files, and it does not include an HTTP server.

## Install

Node.js >=24. Chatmeld has not been published to npm yet.
Build an installable archive from this repository:

```sh
git clone https://github.com/aimuzov/chatmeld.git
cd chatmeld
npm ci
npm pack
```

Install that archive in your backend project:

```sh
npm install -E /path/to/chatmeld-0.1.0.tgz
```

The package ships compiled ESM and TypeScript declarations. The consuming
project does not need `tsx`.

### Provider requirements

| Provider | Additional setup                                                    |
| -------- | ------------------------------------------------------------------- |
| Telegram | Your application's `apiId` and `apiHash`                            |
| MAX      | Python >=3.12 with `maxapi-python==2.5.0`; optional `pythonCommand` |
| WhatsApp | No additional runtime                                               |
| VK       | Playwright Chromium on the machine running Chatmeld                 |

For VK, install the browser next to your application's dependencies:

```sh
npm exec playwright install chromium
```

VK uses an isolated headless browser during authorization. It closes after
success, failure or cancellation. Regular messaging uses the API.

MAX runs a separate Python process. Supply the path to an interpreter that
has the pinned dependency installed. The package includes
`python/pyproject.toml` and `python/uv.lock`; other providers do not need Python.

## QR authorization

```ts
import { createAdapter, type AuthEvent, type SessionStorage } from "chatmeld";

declare const storage: SessionStorage;
declare function publishAuthEvent(event: AuthEvent): Promise<void>;

const adapter = createAdapter({
  provider: "vk",
  accountId: "user-42-vk-main",
  storage,
});

const stop = new AbortController();
const login = adapter.authorize({
  signal: stop.signal,
  onEvent: publishAuthEvent,
});

function handleUserResponse(challengeId: string, value: string) {
  adapter.respondToChallenge({ challengeId, value });
}

await login;
```

Create the adapter in your backend. Forward its authorization events to
your user's web client and send challenge responses back to the same instance.
Your application checks that the user owns that connection.

| Event       | Payload                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `qr`        | `value` to encode as a QR image; `expiresAt` when available                |
| `challenge` | `challengeId`, `kind` (`code` or `password`), `prompt`, optional `pattern` |
| `progress`  | `message` describing the current step                                      |

Replace the displayed QR when a new one arrives. Call `respondToChallenge`
only after receiving its challenge. A response with the wrong format leaves
the challenge open; expired, foreign or already answered IDs are rejected.

In the example, `handleUserResponse` belongs in your request handler.
Starting authorization and submitting its code are separate web requests.
No terminal prompt is involved. VK's six-digit code and Telegram's 2FA
password travel through the same challenge mechanism.

Authorization expires after three minutes. `stop.abort()` cancels it and
closes that adapter's browser or worker without affecting other connections.
The `authorize()` promise resolves only after the session has been saved.

QR payloads, codes and passwords belong only to the connection's owner.
Authorization events never contain saved session tokens or encryption keys.

## Session storage

```ts
interface SessionStorage {
  read(key: string): Promise<Uint8Array | undefined>;
  writeBatch(changes: readonly SessionChange[]): Promise<void>;
}

type SessionChange =
  | { type: "set"; key: string; value: Uint8Array }
  | { type: "delete"; key: string };
```

Provide a storage instance scoped to one user, provider and connected account.
Keep the bytes unchanged. Chatmeld owns the keys and versioned value format;
your project owns the database, encryption and access controls.

Return `undefined` for a missing key. Throw on storage failure instead of
turning it into an empty session. Apply every `writeBatch` atomically and
resolve it after the changes have been committed. Use a database transaction.

Writes are serialized per adapter. Credentials and encryption keys continue
to change after login, particularly in WhatsApp. Save these updates during
the connection's lifetime, not just after authorization.

With several backend processes, assign one active owner to each account.
Chatmeld does not acquire a distributed lock in your database or close
your storage connection pool.

`MemorySessionStorage` is exported for tests and examples. Its contents
disappear when the process exits; use your own persistent implementation
on a server.

## Connect, send and receive

Use `connect()` to restore an existing session. It does not start QR login
automatically. A missing session returns `AdapterError` with `AUTH_REQUIRED`.
Repeat authorization when the provider requires a new login.

```ts
import type { AdapterState, Message } from "chatmeld";

declare function publishState(state: AdapterState): void;
declare function persistIncoming(message: Message): Promise<void>;

const removeState = adapter.onState(publishState);
const removeMessages = adapter.onMessage(persistIncoming);

await adapter.connect();
const chats = await adapter.listChats();
await adapter.sendMessage(chats[0]!.id, "Hello!");
await adapter.disconnect();

removeMessages();
removeState();
```

The examples share the adapter variable. The first authorizes a new account;
the second shows restoring a saved session in a later connection.

Message handlers may be asynchronous. Handler failure or a backlog over
100 messages closes the connection with an explicit error.
Subscriptions return an unsubscribe function.

The `disconnect()` method finishes session writes and closes resources.
It keeps the saved session. Reconnect after its promise resolves.
Concurrent connection, authorization and shutdown operations are rejected.
Shutdown is idempotent.

Every provider needs `accountId` and `storage`. Telegram also needs
`apiId` and `apiHash`. MAX accepts `pythonCommand`. Select the provider
with `telegram`, `max`, `whatsapp` or `vk`.

Messages contain `provider`, `accountId`, `chatId`, `messageId`, `direction`,
`text`, `sentAt`, `attachments` and available sender details. IDs are strings.
For deduplication, include provider, account, chat and message ID.

The subscription delivers incoming messages. Save your outgoing message
after `sendMessage()` returns its `externalId`.

## Boundaries

Chatmeld does not store message history or provide a chat UI, HTTP routes,
user accounts, attachment downloads, reactions or read receipts.
It does not promise exactly-once delivery, gap recovery or a durable outbox.
The consuming project supplies these when needed.

Errors use `AdapterError` with a safe `message` and a machine-readable `code`.
Codes include `AUTH_REQUIRED`, `AUTH_CANCELLED`, `AUTH_TIMEOUT`, `INVALID_STATE`,
`INVALID_OPTIONS`, `INVALID_CHALLENGE`, `INVALID_RESPONSE`, `STORAGE_ERROR`,
`PROVIDER_ERROR`, `HANDLER_ERROR` and `QUEUE_OVERFLOW`.

A session-storage failure stops the connection. Do not continue sending
with encryption-key updates that were not committed.

## Development

```sh
npm ci
npm run setup:max
npm run setup:vk-qr
npm run check
npm test
npm run test:max
npm run test:package
npm pack
```

Tests cover auth challenges, cancellation, isolated storage, SDK boundaries,
RPC and compiled workers. They do not log in to real user accounts.
Live authorization is a separate check with the account owner.
