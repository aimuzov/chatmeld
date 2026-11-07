import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AdapterError, cancelled } from "../../library/errors.js";
import { readStored, writeStored } from "../../library/storage.js";
import { downloadAvatar } from "../../library/avatar.js";
import {
  decodeMediaReference,
  encodeMediaReference,
  downloadMediaUrl,
  mediaFileName,
} from "../../library/media.js";
import type {
  Chat,
  AvatarTarget,
  Avatar,
  MediaFile,
  MediaInput,
  DriverContext,
  Message,
  ProviderDriver,
} from "../../library/types.js";

type Options = { accountId: string; username: string; pythonCommand?: string };
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type Session = { username: string; settings: Record<string, unknown> };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function failure(code: unknown): AdapterError {
  if (code === "UNSUPPORTED_OPERATION")
    return new AdapterError(
      "UNSUPPORTED_OPERATION",
      "Instagram не поддерживает этот формат медиа или подпись.",
    );
  if (code === "AUTH_REQUIRED")
    return new AdapterError(
      "AUTH_REQUIRED",
      "Instagram требует входа или подтверждения в официальном приложении.",
    );
  if (code === "STORAGE_ERROR")
    return new AdapterError(
      "STORAGE_ERROR",
      "Не удалось прочитать или сохранить сессию Instagram.",
    );
  return new AdapterError(
    "PROVIDER_ERROR",
    "Не удалось выполнить операцию Instagram. Проверьте аккаунт в официальном приложении.",
  );
}

class InstagramDriver implements ProviderDriver {
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private context?: DriverContext;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private fault?: Error;
  private stopping = false;
  private abort?: () => void;
  private storageQueue = Promise.resolve();
  private events = new Set<number>();
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(private options: Options) {}
  connect(context: DriverContext) {
    return this.start(context, "connect");
  }
  authorize(context: DriverContext) {
    return this.start(context, "login");
  }

  private async start(
    context: DriverContext,
    method: "connect" | "login",
  ): Promise<void> {
    if (this.child)
      throw new AdapterError("INVALID_STATE", "Instagram уже подключён.");
    if (context.signal.aborted) throw cancelled();
    const saved = await readStored<Session>(
      context.storage,
      "instagram/session",
    );
    if (
      saved !== undefined &&
      (!object(saved) ||
        typeof saved.username !== "string" ||
        !object(saved.settings))
    )
      throw failure("STORAGE_ERROR");
    if (
      saved &&
      saved.username.toLowerCase() !== this.options.username.toLowerCase()
    )
      throw failure("STORAGE_ERROR");
    if (method === "connect" && !saved) throw failure("AUTH_REQUIRED");
    if (context.signal.aborted) throw cancelled();
    this.context = context;
    this.stopping = false;
    this.fault = undefined;
    this.events.clear();
    const script = fileURLToPath(
      new URL("../../../python/instagram_bridge.py", import.meta.url),
    );
    const child = spawn(
      this.options.pythonCommand ?? "python3",
      ["-u", script],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stderr.resume();
    this.exited = new Promise((resolve) =>
      child.once("close", () => {
        if (!this.stopping) this.fail(failure(undefined), child);
        resolve();
      }),
    );
    child.on("error", () => this.fail(failure(undefined), child));
    child.stdin.on("error", () => this.fail(failure(undefined), child));
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child || this.stopping || this.fault) return;
      buffer += chunk;
      if (buffer.length > 1_048_576) {
        this.fail(failure(undefined), child);
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!object(value)) throw new Error();
          this.receive(value, child);
        } catch {
          this.fail(failure(undefined), child);
          return;
        }
      }
    });
    this.abort = () => this.fail(cancelled(), child);
    context.signal.addEventListener("abort", this.abort, { once: true });
    if (context.signal.aborted) this.abort();
    await this.request(
      method,
      {
        accountId: this.options.accountId,
        username: this.options.username,
        settings: saved?.settings,
        pollIntervalSeconds: 15,
      },
      180_000,
    );
  }

  private receive(
    value: Record<string, unknown>,
    child: ChildProcessWithoutNullStreams,
  ): void {
    if (this.fault || this.stopping || this.child !== child) return;
    if (typeof value.id === "number") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if ("error" in value) pending.reject(failure(value.code));
      else pending.resolve(value.result);
      return;
    }
    if (value.event === "session" || value.event === "challenge") {
      const id = value.requestId;
      if (
        !Number.isSafeInteger(id) ||
        typeof id !== "number" ||
        this.events.has(id) ||
        this.events.size >= 100
      ) {
        this.fail(failure(undefined), child);
        return;
      }
      this.events.add(id);
      if (value.event === "session") {
        if (!object(value.settings)) {
          this.fail(failure("STORAGE_ERROR"), child);
          return;
        }
        this.storageQueue = this.storageQueue.then(async () => {
          try {
            if (this.child !== child || this.stopping || this.fault) return;
            await writeStored(this.context!.storage, "instagram/session", {
              username: this.options.username,
              settings: value.settings,
            });
            this.notify(
              { method: "eventResult", requestId: id, result: null },
              child,
            );
          } catch {
            this.fail(failure("STORAGE_ERROR"), child);
          } finally {
            this.events.delete(id);
          }
        });
      } else {
        const auth = this.context?.auth;
        if (!auth || (value.kind !== "code" && value.kind !== "password")) {
          this.fail(failure("AUTH_REQUIRED"), child);
          return;
        }
        void auth
          .challenge({
            kind: value.kind,
            prompt:
              value.kind === "password"
                ? "Пароль Instagram"
                : "Код подтверждения Instagram",
            ...(value.kind === "code"
              ? { pattern: "^(?:[0-9]{6}|[0-9]{8})$" }
              : {}),
          })
          .then(
            (result) =>
              this.notify(
                { method: "eventResult", requestId: id, result },
                child,
              ),
            () => this.fail(cancelled(), child),
          )
          .finally(() => this.events.delete(id));
      }
    } else if (value.event === "message") {
      if (
        !object(value.message) ||
        value.message.provider !== "instagram" ||
        value.message.accountId !== this.options.accountId
      ) {
        this.fail(failure(undefined), child);
        return;
      }
      this.context?.onMessage(this.mapMessage(value.message));
    } else if (value.event === "fatal") this.fail(failure(value.code), child);
  }

  private notify(value: unknown, expected = this.child): void {
    if (expected && this.child === expected && !this.fault && !this.stopping)
      expected.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private request<T>(
    method: string,
    params: unknown = {},
    timeout = 45_000,
  ): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    if (!this.child || this.stopping)
      return Promise.reject(
        new AdapterError("DISCONNECTED", "Instagram отключён."),
      );
    if (this.pending.size >= 100)
      return Promise.reject(
        new AdapterError("QUEUE_OVERFLOW", "Слишком много запросов Instagram."),
      );
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(failure(undefined)), timeout);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.notify({ id, method, params });
    });
  }
  private fail(error: Error, expected = this.child): void {
    if (this.fault || this.stopping || this.child !== expected) return;
    this.fault = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    expected?.kill("SIGTERM");
    if (expected && !this.killTimer) {
      this.killTimer = setTimeout(() => expected.kill("SIGKILL"), 1000);
      void this.exited?.then(() => {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      });
    }
    this.context?.onError(error);
  }
  listChats(): Promise<Chat[]> {
    return this.request("chats");
  }
  private mapMessage(value: unknown): Message {
    if (
      !object(value) ||
      value.provider !== "instagram" ||
      value.accountId !== this.options.accountId ||
      !Array.isArray(value.attachments)
    )
      throw failure(undefined);
    return {
      ...value,
      attachments: value.attachments.map((item: Record<string, unknown>) => {
        const { referencePayload, ...metadata } = item;
        return {
          ...metadata,
          ...(object(referencePayload)
            ? {
                reference: encodeMediaReference(
                  "instagram",
                  this.options.accountId,
                  referencePayload,
                ),
              }
            : {}),
        };
      }),
    } as unknown as Message;
  }
  async sendMedia(
    chatId: string,
    media: MediaInput,
  ): Promise<{ externalId: string }> {
    return this.request(
      "sendMedia",
      {
        chatId,
        media: {
          ...media,
          data: Buffer.from(media.data).toString("base64"),
          fileName: mediaFileName(media),
        },
      },
      120_000,
    );
  }
  async downloadMedia(reference: string): Promise<MediaFile> {
    const payload = decodeMediaReference(
      reference,
      "instagram",
      this.options.accountId,
    );
    const file = await this.request<{
      url: string;
      mimeType?: string;
      fileName?: string;
    }>("downloadMedia", { payload }, 120_000);
    return downloadMediaUrl(file.url, ["cdninstagram.com", "fbcdn.net"], {
      signal: this.context?.signal,
      mimeType: file.mimeType,
      fileName: file.fileName,
    });
  }
  async getAvatar(target: AvatarTarget): Promise<Avatar | undefined> {
    const url = await this.request<string | null>("avatar", { target });
    return downloadAvatar(
      url ?? undefined,
      ["cdninstagram.com", "fbcdn.net"],
      this.context?.signal,
    );
  }
  async listMessages(
    chatId: string,
    options: { limit?: number } = {},
  ): Promise<Message[]> {
    const messages = await this.request<unknown[]>("history", {
      chatId,
      limit: options.limit ?? 100,
    });
    return messages.map((message) => this.mapMessage(message));
  }
  async listHistoryPage(
    chatId: string,
    options: { limit: number; cursor?: string },
  ) {
    const page = await this.request<{
      messages: unknown[];
      nextCursor?: string;
    }>("historyPage", { chatId, ...options });
    return {
      messages: page.messages.map((message) => this.mapMessage(message)),
      nextCursor: page.nextCursor ?? undefined,
    };
  }
  sendMessage(chatId: string, text: string): Promise<{ externalId: string }> {
    return this.request("send", { chatId, text });
  }
  async disconnect(): Promise<void> {
    this.stopping = true;
    this.context?.signal.removeEventListener("abort", this.abort!);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AdapterError("DISCONNECTED", "Instagram отключён."));
    }
    this.pending.clear();
    const child = this.child;
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
      }
      this.child = undefined;
    }
    await this.storageQueue;
    this.events.clear();
    this.context = undefined;
  }
}

export function createInstagramDriver(options: Options): ProviderDriver {
  return new InstagramDriver({ ...options });
}
