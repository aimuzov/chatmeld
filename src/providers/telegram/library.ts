import { Api, TelegramClient, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { NewMessage, Raw, type NewMessageEvent } from "teleproto/events";
import { Logger, LogLevel } from "teleproto/extensions/Logger";
import type {
  Chat,
  DriverContext,
  ProviderDriver,
} from "../../library/types.js";
import { readStored, writeStored } from "../../library/storage.js";
import { AdapterError } from "../../library/errors.js";
import { normalizeMessage } from "./normalize.js";
import { telegramLoginUrl } from "./qr.js";

export function createTelegramDriver(options: {
  accountId: string;
  apiId: number;
  apiHash: string;
}): ProviderDriver {
  return new TelegramDriver(options);
}

class TelegramDriver implements ProviderDriver {
  private client?: TelegramClient;
  private session?: StringSession;
  private context?: DriverContext;
  private writes: Promise<void> = Promise.resolve();
  private failure?: Error;
  private removeAbort?: () => void;
  private removeUpdates?: () => void;

  constructor(
    private options: { accountId: string; apiId: number; apiHash: string },
  ) {}

  private queueSession(): void {
    if (!this.session || !this.context || this.failure) return;
    const value = { session: StringSession.prototype.save.call(this.session) };
    this.writes = this.writes.then(() =>
      writeStored(this.context!.storage, "telegram/session", value),
    );
    void this.writes.catch(() => {
      if (this.failure) return;
      this.failure = new Error("Не удалось сохранить сессию Telegram.");
      this.context?.onError(this.failure);
      void this.client?.destroy().catch(() => undefined);
    });
  }

  private async open(
    context: DriverContext,
    authorize: boolean,
  ): Promise<void> {
    context.signal.throwIfAborted();
    this.context = context;
    this.failure = undefined;
    this.writes = Promise.resolve();
    const stored = await readStored<{ session: string }>(
      context.storage,
      "telegram/session",
    );
    if (!authorize && !stored)
      throw new AdapterError(
        "AUTH_REQUIRED",
        "Нет сохранённой сессии Telegram.",
      );
    if (stored && typeof stored.session !== "string")
      throw new Error("Некорректная сессия Telegram.");
    this.session = new StringSession(stored?.session ?? "");
    this.client = new TelegramClient(
      this.session,
      this.options.apiId,
      this.options.apiHash,
      {
        connectionRetries: 5,
        baseLogger: new Logger(LogLevel.NONE),
        deviceModel: "chatmeld",
        appVersion: "0.1.0",
      },
    );
    const client = this.client;
    const abort = () => {
      void client.destroy().catch(() => undefined);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    this.removeAbort = () => context.signal.removeEventListener("abort", abort);
    try {
      await client.connect();
      context.signal.throwIfAborted();
      if (authorize && !(await client.checkAuthorization())) {
        if (!context.auth)
          throw new Error("Не задан канал авторизации Telegram.");
        await client.signInUserWithQrCode(
          { apiId: this.options.apiId, apiHash: this.options.apiHash },
          {
            abortSignal: context.signal,
            qrCode: ({ token, expires }) =>
              context.auth!.qr(
                telegramLoginUrl(token),
                new Date(expires * 1000).toISOString(),
              ),
            password: () =>
              context.auth!.challenge({
                kind: "password",
                prompt: "Пароль двухэтапной проверки Telegram",
              }),
            onError: (error) => {
              throw error;
            },
          },
        );
      }
      if (!(await client.checkAuthorization()))
        throw new AdapterError(
          "AUTH_REQUIRED",
          "Сессия Telegram не авторизована.",
        );
      if ((await client.getMe()).bot)
        throw new Error("Требуется личный аккаунт Telegram.");
      context.signal.throwIfAborted();
      this.session.save = () => {
        const value = StringSession.prototype.save.call(this.session!);
        this.queueSession();
        return value;
      };
      this.queueSession();
      await this.writes;
      this.subscribe();
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }

  connect(context: DriverContext): Promise<void> {
    return this.open(context, false);
  }
  authorize(context: DriverContext): Promise<void> {
    return this.open(context, true);
  }

  private ready(): TelegramClient {
    if (this.failure) throw this.failure;
    if (!this.client) throw new Error("Telegram не подключён.");
    this.context!.signal.throwIfAborted();
    return this.client;
  }

  private subscribe(): void {
    const client = this.ready();
    const builder = new NewMessage({ incoming: true });
    const receive = async (event: NewMessageEvent) => {
      if (this.context!.signal.aborted || this.client !== client) return;
      try {
        const message = normalizeMessage(event.message, this.options.accountId);
        if (message.chatId === "777000") return;
        const sender = event.message.sender;
        if (sender) {
          message.displayName = utils.getDisplayName(sender);
          if (sender instanceof Api.User || sender instanceof Api.Channel)
            message.username = sender.username;
        }
        this.queueSession();
        await this.writes;
        this.context!.onMessage(message);
      } catch {
        this.context?.onError(
          new Error("Не удалось обработать сообщение Telegram."),
        );
      }
    };
    client.addEventHandler(receive, builder);
    this.removeUpdates = () => client.removeEventHandler(receive, builder);
    const changed = async () => {
      this.queueSession();
      await this.writes.catch(() => undefined);
    };
    const raw = new Raw({});
    client.addEventHandler(changed, raw);
    const removeMessages = this.removeUpdates;
    this.removeUpdates = () => {
      removeMessages();
      client.removeEventHandler(changed, raw);
    };
  }

  async listChats(): Promise<Chat[]> {
    const chats: Chat[] = [];
    for await (const dialog of this.ready().iterDialogs({})) {
      if (dialog.id)
        chats.push({ id: dialog.id.toString(), title: dialog.title ?? "" });
    }
    this.queueSession();
    await this.writes;
    return chats;
  }

  async listMessages(chatId: string, options: { limit?: number } = {}) {
    if (!(await this.listChats()).some((chat) => chat.id === chatId))
      throw new Error("Чат Telegram не найден.");
    const messages = await this.ready().getMessages(chatId, {
      limit: options.limit ?? 100,
    });
    return messages
      .filter((message) => message instanceof Api.Message)
      .map((message) => {
        const normalized = normalizeMessage(message, this.options.accountId);
        if (message.sender)
          normalized.displayName = utils.getDisplayName(message.sender);
        return normalized;
      });
  }

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<{ externalId: string }> {
    if (!text.trim()) throw new Error("Укажите непустой текст Telegram.");
    if (!(await this.listChats()).some((chat) => chat.id === chatId))
      throw new Error("Чат Telegram не найден.");
    const message = await this.ready().sendMessage(chatId, {
      message: text,
      parseMode: false,
    });
    this.queueSession();
    await this.writes;
    return { externalId: `${chatId}:${message.id}` };
  }

  async disconnect(): Promise<void> {
    this.removeAbort?.();
    this.removeAbort = undefined;
    this.removeUpdates?.();
    this.removeUpdates = undefined;
    const client = this.client;
    this.client = undefined;
    try {
      if (client) await client.destroy();
    } finally {
      await this.writes;
    }
  }
}
