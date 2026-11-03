import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import type { Chat, Message, MessagingProvider } from "../../core/provider.js";
import { JsonProcess } from "../../core/json-process.js";

export class WhatsAppProvider implements MessagingProvider {
  readonly kind = "whatsapp";
  private rpc?: JsonProcess;
  private handlers = new Set<(message: Message) => void>();
  private errors = new Set<(error: Error) => void>();
  private fault?: Error;

  constructor(
    readonly accountId: string,
    private sessionDir: string,
  ) {}

  async connect(): Promise<void> {
    this.rpc = new JsonProcess(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("./worker.ts", import.meta.url)),
      ],
      (event) => {
        void this.event(event).catch((error: Error) => this.fail(error));
      },
      (error) => this.fail(error),
      "WhatsApp",
    );
    await this.rpc.request("ping");
  }

  private fail(error: Error): void {
    if (this.fault) return;
    this.fault = error;
    for (const handler of this.errors) handler(error);
    this.rpc?.abort(error);
  }

  private async event(event: Record<string, unknown>): Promise<void> {
    if (event.event === "qr" && typeof event.value === "string") {
      console.error(
        "WhatsApp → Связанные устройства → Привязка устройства. Отсканируйте QR:",
      );
      console.error(
        await QRCode.toString(event.value, { type: "terminal", small: true }),
      );
    } else if (event.event === "message") {
      for (const handler of this.handlers) handler(event.message as Message);
    } else if (event.event === "fatal")
      this.fail(new Error(String(event.error)));
    else if (event.event === "notice") console.error(String(event.text));
  }

  private call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout?: number,
  ): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    if (!this.rpc) return Promise.reject(new Error("WhatsApp не подключён."));
    return this.rpc.request(
      method,
      { accountId: this.accountId, sessionDir: this.sessionDir, ...params },
      timeout,
    );
  }

  async login(): Promise<void> {
    const abort = () => {
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
    await this.call("authorize", {}, 90_000);
  }
  listChats(): Promise<Chat[]> {
    return this.call("chats", {}, 60_000);
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
    const rpc = this.rpc;
    this.rpc = undefined;
    await rpc?.close();
  }
}
