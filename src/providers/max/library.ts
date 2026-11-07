import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AdapterError, cancelled } from "../../library/errors.js";
import { downloadAvatar } from "../../library/avatar.js";
import {
  decodeMediaReference,
  downloadMediaUrl,
  encodeMediaReference,
  mediaFileName,
  validateMedia,
} from "../../library/media.js";
import type {
  Avatar,
  AvatarTarget,
  Chat,
  DriverContext,
  Message,
  MediaInput,
  MediaFile,
  MessageReceipt,
  ProviderDriver,
  SessionChange,
} from "../../library/types.js";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

class MaxDriver implements ProviderDriver {
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private context?: DriverContext;
  private fault?: Error;
  private stopping = false;
  private storageQueue: Promise<void> = Promise.resolve();
  private abort?: () => void;
  private queuedStorage = 0;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(private options: { accountId: string; pythonCommand?: string }) {}

  connect(context: DriverContext): Promise<void> {
    return this.start(context, "connect");
  }

  authorize(context: DriverContext): Promise<void> {
    return this.start(context, "login");
  }

  private async start(context: DriverContext, method: string): Promise<void> {
    if (this.child)
      throw new AdapterError("INVALID_STATE", "MAX connection already active");
    if (context.signal.aborted) throw cancelled();
    this.context = context;
    this.fault = undefined;
    this.stopping = false;
    const path = fileURLToPath(
      new URL("../../../python/library_bridge.py", import.meta.url),
    );
    const child = spawn(this.options.pythonCommand ?? "python3", ["-u", path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.resume();
    this.exited = new Promise((resolve) =>
      child.once("close", () => {
        if (!this.stopping) this.fail(new Error("MAX worker stopped"));
        resolve();
      }),
    );
    child.on("error", () => this.fail(new Error("MAX worker could not start")));
    child.stdin.on("error", () =>
      this.fail(new Error("MAX worker pipe failed")),
    );
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) {
        this.fail(new Error("MAX worker response exceeded limit"));
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (!value || typeof value !== "object") throw new Error();
          this.receive(value);
        } catch {
          this.fail(new Error("Invalid MAX worker response"));
          return;
        }
      }
    });
    this.abort = () => this.fail(cancelled());
    context.signal.addEventListener("abort", this.abort, { once: true });
    if (context.signal.aborted) this.abort();
    try {
      await this.request(
        method,
        { accountId: this.options.accountId },
        180_000,
      );
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("MAX connection failed"),
      );
      throw this.fault;
    }
  }

  private receive(value: Record<string, unknown>): void {
    if (this.fault || this.stopping) return;
    if (typeof value.id === "number") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (typeof value.error === "string")
        pending.reject(
          new AdapterError(
            value.code === "AUTH_REQUIRED"
              ? "AUTH_REQUIRED"
              : value.code === "UNSUPPORTED_OPERATION"
                ? "UNSUPPORTED_OPERATION"
                : "PROVIDER_ERROR",
            "MAX request failed",
          ),
        );
      else pending.resolve(value.result);
      return;
    }
    if (value.event === "storage") {
      if (++this.queuedStorage > 100) {
        this.fail(
          new AdapterError("QUEUE_OVERFLOW", "MAX storage queue exceeded"),
        );
        return;
      }
      this.storageQueue = this.storageQueue.then(async () => {
        this.queuedStorage--;
        if (this.fault) return;
        const context = this.context!;
        try {
          let result: string | null = null;
          if (value.method === "read" && typeof value.key === "string") {
            const bytes = await context.storage.read(value.key);
            result =
              bytes === undefined
                ? null
                : Buffer.from(bytes).toString("base64");
          } else if (
            value.method === "writeBatch" &&
            Array.isArray(value.changes)
          ) {
            const changes = value.changes.map(
              (change: Record<string, unknown>): SessionChange => {
                if (typeof change.key !== "string") throw new Error();
                if (change.type === "delete")
                  return { type: "delete", key: change.key };
                if (change.type !== "set" || typeof change.value !== "string")
                  throw new Error();
                return {
                  type: "set",
                  key: change.key,
                  value: Buffer.from(change.value, "base64"),
                };
              },
            );
            await context.storage.writeBatch(changes);
          } else throw new Error();
          this.notify({
            method: "storageResult",
            requestId: value.requestId,
            result,
          });
        } catch {
          this.notify({
            method: "storageResult",
            requestId: value.requestId,
            error: "MAX storage failed",
          });
          this.fail(new AdapterError("STORAGE_ERROR", "MAX storage failed"));
        }
      });
    } else if (value.event === "qr" && typeof value.url === "string") {
      void this.context?.auth
        ?.qr(value.url)
        .catch(() => this.fail(new Error("MAX auth event failed")));
    } else if (value.event === "password") {
      const auth = this.context?.auth;
      if (!auth) {
        this.fail(new Error("MAX authorization required"));
        return;
      }
      void auth.challenge({ kind: "password", prompt: "Пароль MAX" }).then(
        (password) => {
          this.notify({ method: "password", value: password });
        },
        () => this.fail(new Error("MAX challenge failed")),
      );
    } else if (value.event === "receipt") {
      this.context?.onReceipt?.(value.receipt as MessageReceipt);
    } else if (value.event === "message") {
      const message = value.message as Omit<Message, "attachments"> & {
        attachments: (Message["attachments"][number] & {
          referencePayload?: unknown;
        })[];
      };
      this.context?.onMessage({
        ...message,
        attachments: message.attachments.map(
          ({ referencePayload, ...attachment }) => ({
            ...attachment,
            ...(referencePayload
              ? {
                  reference: encodeMediaReference(
                    "max",
                    this.options.accountId,
                    referencePayload,
                  ),
                }
              : {}),
          }),
        ),
      });
    } else if (value.event === "fatal")
      this.fail(new Error("MAX connection failed"));
  }

  private notify(value: unknown): void {
    if (this.child && !this.fault && !this.stopping)
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request<T>(
    method: string,
    params: unknown = {},
    timeout = 45_000,
  ): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    if (!this.child || this.stopping)
      return Promise.reject(new Error("MAX is disconnected"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("MAX request timed out")),
        timeout,
      );
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.notify({ id, method, params });
    });
  }

  private fail(error: Error): void {
    if (this.fault || this.stopping) return;
    this.fault = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const child = this.child;
    child?.kill("SIGTERM");
    if (child && !this.killTimer) {
      this.killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      void this.exited?.then(() => {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      });
    }
    this.context?.signal.removeEventListener("abort", this.abort!);
    this.context?.onError(error);
  }

  listChats(): Promise<Chat[]> {
    return this.request("chats");
  }

  async getAvatar(target: AvatarTarget): Promise<Avatar | undefined> {
    const url = await this.request<string | null>("avatar", target);
    return downloadAvatar(
      url ?? undefined,
      ["i.oneme.ru"],
      this.context?.signal,
    );
  }

  sendMessage(
    chatId: string,
    text: string,
  ): Promise<{ externalId: string; sentAt?: string }> {
    return this.request("send", { chatId, text });
  }

  sendMedia(
    chatId: string,
    media: MediaInput,
  ): Promise<{ externalId: string }> {
    validateMedia(media);
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
      "max",
      this.options.accountId,
    );
    const result = await this.request<{
      url: string;
      mimeType: string;
      fileName?: string;
    }>("downloadMedia", { payload });
    return downloadMediaUrl(result.url, ["oneme.ru", "okcdn.ru", "max.ru"], {
      mimeType: result.mimeType,
      ...(result.fileName ? { fileName: result.fileName } : {}),
      ...(this.context ? { signal: this.context.signal } : {}),
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.context?.signal.removeEventListener("abort", this.abort!);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MAX is disconnected"));
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
    this.context = undefined;
  }
}

export function createMaxDriver(options: {
  accountId: string;
  pythonCommand?: string;
}): ProviderDriver {
  return new MaxDriver(options);
}
