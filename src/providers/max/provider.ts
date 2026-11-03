import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { password } from "@inquirer/prompts";
import QRCode from "qrcode";
import type { Chat, Message, MessagingProvider } from "../../core/provider.js";
import { JsonProcess } from "../../core/json-process.js";

export class MaxProvider implements MessagingProvider {
  readonly kind = "max";
  private rpc?: JsonProcess;
  private handlers = new Set<(message: Message) => void>();
  private errors = new Set<(error: Error) => void>();
  private stopped = new AbortController();
  private fault?: Error;

  constructor(
    readonly accountId: string,
    private sessionFile: string,
  ) {}

  async connect(): Promise<void> {
    const root = fileURLToPath(new URL("../../../python/", import.meta.url));
    const python = join(root, ".venv", "bin", "python");
    await access(python).catch(() => {
      throw new Error("Установите зависимости MAX: npm run setup:max");
    });
    this.rpc = new JsonProcess(
      python,
      ["-u", join(root, "bridge.py")],
      (event) => {
        void this.event(event).catch((error: Error) => this.fail(error));
      },
      (error) => {
        this.stopped.abort();
        this.fail(error);
      },
    );
    await this.rpc.request("ping");
  }

  private fail(error: Error): void {
    if (this.fault) return;
    this.fault = error;
    this.stopped.abort();
    for (const handler of this.errors) handler(error);
    this.rpc?.abort(error);
  }

  private async event(event: Record<string, unknown>): Promise<void> {
    if (event.event === "qr" && typeof event.url === "string") {
      console.error("Откройте сканер QR в MAX на телефоне и подтвердите вход.");
      console.error(
        await QRCode.toString(event.url, { type: "terminal", small: true }),
      );
    } else if (event.event === "password") {
      const value = await password(
        { message: "Пароль MAX:", mask: "*" },
        { signal: this.stopped.signal },
      );
      this.rpc?.notify({ method: "password", value });
    } else if (event.event === "message") {
      for (const handler of this.handlers) handler(event.message as Message);
    } else if (event.event === "fatal") {
      this.fail(new Error(String(event.error)));
    }
  }

  private call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout?: number,
  ): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    if (!this.rpc) return Promise.reject(new Error("MAX не подключён."));
    return this.rpc.request<T>(
      method,
      { accountId: this.accountId, sessionFile: this.sessionFile, ...params },
      timeout,
    );
  }

  async login(): Promise<void> {
    const abort = () => {
      this.stopped.abort();
      void this.disconnect();
    };
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await this.call("login", {}, 180_000);
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }

  async requireAuthorization(): Promise<void> {
    await this.call("authorize");
  }
  listChats(): Promise<Chat[]> {
    return this.call("chats");
  }
  sendMessage(chatId: string, text: string): Promise<{ externalId: string }> {
    return this.call("send", { chatId, text });
  }

  subscribe(handler: (message: Message) => void): () => void {
    this.handlers.add(handler);
    void this.call("listen").catch((error: Error) => this.fail(error));
    return () => {
      this.handlers.delete(handler);
      if (!this.handlers.size)
        void this.call("unlisten").catch(() => undefined);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errors.add(handler);
    if (this.fault) handler(this.fault);
    return () => {
      this.errors.delete(handler);
    };
  }

  async disconnect(): Promise<void> {
    this.stopped.abort();
    const rpc = this.rpc;
    this.rpc = undefined;
    await rpc?.close();
  }
}
