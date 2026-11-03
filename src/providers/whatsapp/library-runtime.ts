import makeWASocket, {
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import type { DriverContext } from "../../library/types.js";
import { AdapterError } from "../../library/errors.js";
import { createWhatsAppAuthState } from "./session-storage.js";
import { WhatsAppCatalog } from "./catalog.js";
import { isChatId, normalizeMessage } from "./normalize.js";
import { connectionOptions } from "./connection.js";
import { hasSession } from "./auth.js";

export class WhatsAppLibraryRuntime {
  private socket?: WASocket;
  private auth?: Awaited<ReturnType<typeof createWhatsAppAuthState>>;
  private catalog = new WhatsAppCatalog();
  private fault?: Error;
  private stopped = false;
  private rejectOpen?: (error: Error) => void;
  private credentials = Promise.resolve();
  private connected = false;
  private context?: DriverContext;

  constructor(
    private accountId: string,
    private makeSocket: typeof makeWASocket = makeWASocket,
  ) {}

  private fail(error: Error): void {
    if (this.fault || this.stopped) return;
    this.fault = error;
    this.connected = false;
    this.rejectOpen?.(error);
    this.socket?.end(undefined);
    this.context?.onError(error);
  }

  async open(context: DriverContext, authorize: boolean): Promise<void> {
    this.context = context;
    this.auth = await createWhatsAppAuthState(context.storage, (error) =>
      this.fail(error),
    );
    if (!authorize && !hasSession(this.auth.state.creds))
      throw new AdapterError(
        "AUTH_REQUIRED",
        "Нет сохранённой сессии WhatsApp.",
      );
    if (context.signal.aborted)
      throw new Error("Подключение WhatsApp отменено.");
    const aborted = () =>
      this.fail(new Error("Подключение WhatsApp отменено."));
    context.signal.addEventListener("abort", aborted, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.rejectOpen = reject;
        const timer = setTimeout(
          () => this.fail(new Error("Истекло время подключения WhatsApp.")),
          authorize ? 120_000 : 30_000,
        );
        const success = () => {
          clearTimeout(timer);
          resolve();
        };
        const failure = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        this.rejectOpen = failure;
        try {
          this.openSocket(context, authorize, success, 0);
        } catch {
          this.fail(new Error("Не удалось подключить WhatsApp."));
        }
      });
    } finally {
      context.signal.removeEventListener("abort", aborted);
    }
  }

  private openSocket(
    context: DriverContext,
    authorize: boolean,
    opened: () => void,
    restarts: number,
  ): void {
    const socket = this.makeSocket({
      auth: this.auth!.state,
      logger: pino({ level: "silent" }),
      ...connectionOptions(),
    });
    this.socket = socket;
    socket.ev.on("creds.update", (update) => {
      Object.assign(this.auth!.state.creds, update);
      const save = this.auth!.saveCreds();
      this.credentials = this.credentials.then(() => save);
      void this.credentials.catch(() =>
        this.fail(
          new AdapterError(
            "STORAGE_ERROR",
            "Ошибка хранилища сессии WhatsApp.",
          ),
        ),
      );
    });
    socket.ev.on("connection.update", (update) => {
      void (async () => {
        if (this.socket !== socket || this.stopped || this.fault) return;
        if (update.qr) {
          if (!authorize || !context.auth)
            throw new AdapterError(
              "AUTH_REQUIRED",
              "Сессия WhatsApp недействительна.",
            );
          await context.auth.qr(update.qr);
        }
        if (update.connection === "open") {
          await this.auth!.saveCreds();
          await this.credentials;
          await this.auth!.flush();
          if (this.stopped || this.fault) return;
          this.connected = true;
          opened();
          if (this.auth!.state.creds.myAppStateKeyId)
            void socket
              .resyncAppState(["critical_unblock_low"], true)
              .catch(() =>
                this.fail(new Error("Ошибка синхронизации WhatsApp.")),
              );
        }
        if (update.connection === "close") {
          this.connected = false;
          const status = (
            update.lastDisconnect?.error as
              { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          if (status === DisconnectReason.restartRequired && restarts < 3) {
            await this.credentials;
            await this.auth!.flush();
            if (!this.stopped && !this.fault)
              this.openSocket(context, authorize, opened, restarts + 1);
          } else if (status === DisconnectReason.loggedOut) {
            throw new AdapterError(
              "AUTH_REQUIRED",
              "Сессия WhatsApp отозвана.",
            );
          } else throw new Error("Соединение WhatsApp закрыто.");
        }
      })().catch((error: unknown) =>
        this.fail(
          error instanceof Error ? error : new Error("Ошибка WhatsApp."),
        ),
      );
    });
    socket.ev.on("messaging-history.set", (data) => {
      this.catalog.chats(data.chats);
      this.catalog.contacts(data.contacts);
      this.catalog.mappings(data.lidPnMappings ?? []);
      for (const message of data.messages) this.catalog.observe(message);
    });
    socket.ev.on("chats.upsert", (items) => this.catalog.chats(items));
    socket.ev.on("chats.update", (items) => this.catalog.chats(items));
    socket.ev.on("chats.delete", (items) => this.catalog.remove(items));
    socket.ev.on("contacts.upsert", (items) => this.catalog.contacts(items));
    socket.ev.on("contacts.update", (items) => this.catalog.contacts(items));
    socket.ev.on("lid-mapping.update", (item) => this.catalog.mappings([item]));
    socket.ev.on("messages.upsert", (data) => {
      if (this.stopped || this.fault) return;
      for (const item of data.messages) {
        this.catalog.observe(item);
        if (data.type !== "notify") continue;
        const message = normalizeMessage(item, this.accountId);
        if (message) context.onMessage(message);
      }
    });
  }

  listChats() {
    this.requireConnection();
    return this.catalog.list();
  }

  private requireConnection(): void {
    if (this.fault) throw this.fault;
    if (!this.connected || this.stopped)
      throw new Error("WhatsApp не подключён.");
  }

  async sendMessage(chatId: string, text: string) {
    this.requireConnection();
    if (!isChatId(chatId) || !text.trim())
      throw new Error("Некорректный чат или пустое сообщение WhatsApp.");
    const message = await this.socket!.sendMessage(chatId, { text });
    await this.auth!.flush();
    this.requireConnection();
    if (!message?.key.id) throw new Error("WhatsApp не подтвердил отправку.");
    return { externalId: `${chatId}:${message.key.id}` };
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.rejectOpen?.(new Error("Подключение WhatsApp отменено."));
    this.socket?.end(undefined);
    await this.credentials;
    await this.auth?.flush();
  }
}
