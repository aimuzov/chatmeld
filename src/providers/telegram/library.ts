import {
  FileReferenceExpiredError,
  FileReferenceInvalidError,
  FileIdInvalidError,
} from "teleproto/errors";
import { CustomFile } from "teleproto/client/uploads";
import { Api, TelegramClient, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { NewMessage, Raw, type NewMessageEvent } from "teleproto/events";
import { Logger, LogLevel } from "teleproto/extensions/Logger";
import type {
  MediaInput,
  MediaFile,
  Avatar,
  AvatarTarget,
  Chat,
  DriverContext,
  ProviderDriver,
} from "../../library/types.js";
import { inferAvatar } from "../../library/avatar.js";
import { readStored, writeStored } from "../../library/storage.js";
import { AdapterError } from "../../library/errors.js";
import {
  MAX_MEDIA_BYTES,
  decodeMediaReference,
  mediaFileName,
  validateMedia,
} from "../../library/media.js";
import { normalizeMessage, telegramAttachments } from "./normalize.js";
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
  private dialogIds = new Set<string>();
  private dialogLoad?: Promise<Chat[]>;

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
    const proxy = process.env.CHATMELD_TELEGRAM_SOCKS;
    const route = proxy ? new URL(proxy) : undefined;
    if (route && (route.protocol !== "socks5:" || !route.port))
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Неверный адрес SOCKS5 для Telegram.",
      );
    this.client = new TelegramClient(
      this.session,
      this.options.apiId,
      this.options.apiHash,
      {
        connectionRetries: 5,
        ...(route && {
          proxy: {
            socksType: 5 as const,
            ip: route.hostname,
            port: Number(route.port),
          },
        }),
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
    const changed = async (update: Api.TypeUpdate) => {
      if (this.context!.signal.aborted || this.client !== client) return;
      if (
        update instanceof Api.UpdateReadHistoryOutbox &&
        update.peer instanceof Api.PeerUser
      ) {
        const chatId = utils.getPeerId(update.peer);
        this.context!.onReceipt?.({
          provider: "telegram",
          accountId: this.options.accountId,
          chatId,
          status: "read",
          throughMessageId: `${chatId}:${update.maxId}`,
        });
      }
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
    const client = this.ready();
    if (this.dialogLoad) return this.dialogLoad;
    const load = this.loadDialogs(client);
    this.dialogLoad = load;
    try {
      return await load;
    } finally {
      if (this.dialogLoad === load) this.dialogLoad = undefined;
    }
  }

  private async loadDialogs(client: TelegramClient): Promise<Chat[]> {
    const chats: Chat[] = [];
    for await (const dialog of client.iterDialogs({})) {
      if (dialog.id)
        chats.push({ id: dialog.id.toString(), title: dialog.title ?? "" });
    }
    this.queueSession();
    await this.writes;
    if (this.client === client)
      this.dialogIds = new Set(chats.map((chat) => chat.id));
    return chats;
  }

  async getAvatar(target: AvatarTarget): Promise<Avatar | undefined> {
    const client = this.ready();
    if (target.type === "chat" && !this.dialogIds.has(target.id)) {
      const chats = await this.listChats();
      if (!chats.some((chat) => chat.id === target.id))
        throw new AdapterError("INVALID_OPTIONS", "Чат Telegram не найден.");
    }
    try {
      const data = await client.downloadProfilePhoto(target.id, {
        isBig: false,
      });
      this.queueSession();
      await this.writes;
      if (!data || typeof data === "string" || data.length === 0)
        return undefined;
      return inferAvatar(data);
    } catch (error) {
      if (this.failure) throw this.failure;
      throw new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось получить аватар Telegram.",
      );
    }
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

  async sendMedia(
    chatId: string,
    media: MediaInput,
  ): Promise<{ externalId: string }> {
    validateMedia(media);
    if (!(await this.listChats()).some((chat) => chat.id === chatId))
      throw new AdapterError("INVALID_OPTIONS", "Чат Telegram не найден.");
    try {
      const message = await this.ready().sendFile(chatId, {
        file: new CustomFile(
          mediaFileName(media),
          media.data.length,
          "",
          Buffer.from(media.data),
        ),
        caption: media.caption ?? "",
        parseMode: false,
        supportsStreaming:
          media.kind === "video" && media.mimeType === "video/mp4",
        voiceNote: false,
        forceDocument: media.kind === "audio",
        ...(media.kind === "audio"
          ? {
              attributes: [
                new Api.DocumentAttributeAudio({
                  duration: 0,
                  title: mediaFileName(media),
                }),
              ],
            }
          : {}),
      });
      this.queueSession();
      await this.writes;
      if (!message.id) throw new Error("SEND_NOT_CONFIRMED");
      return { externalId: `${chatId}:${message.id}` };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось отправить медиа Telegram.",
      );
    }
  }

  async downloadMedia(reference: string): Promise<MediaFile> {
    const value = decodeMediaReference(
      reference,
      "telegram",
      this.options.accountId,
    );
    if (
      typeof value.chatId !== "string" ||
      typeof value.messageId !== "string" ||
      !/^\d+$/.test(value.messageId) ||
      !Number.isSafeInteger(Number(value.messageId))
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа Telegram.",
      );
    if (
      !this.dialogIds.has(value.chatId) &&
      !(await this.listChats()).some((chat) => chat.id === value.chatId)
    )
      throw new AdapterError("INVALID_OPTIONS", "Чат Telegram не найден.");
    let exceededLimit = false;
    try {
      const client = this.ready();
      const messages = await client.getMessages(value.chatId, {
        ids: [Number(value.messageId)],
      });
      const message = messages[0];
      if (
        !(message instanceof Api.Message) ||
        message.id !== Number(value.messageId)
      )
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Сообщение или медиа Telegram больше недоступно.",
        );
      const attachment = telegramAttachments(
        message,
        this.options.accountId,
      )[0];
      if (!attachment?.reference)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Это вложение Telegram нельзя скачать как медиафайл.",
        );
      if (attachment.size !== undefined && attachment.size > MAX_MEDIA_BYTES)
        throw new AdapterError(
          "INVALID_OPTIONS",
          "Медиа Telegram превышает допустимый размер.",
        );
      if (
        message.media instanceof Api.MessageMediaPhoto &&
        message.media.photo instanceof Api.Photo
      ) {
        for (const size of message.media.photo.sizes) {
          const full =
            "size" in size
              ? size.size
              : "sizes" in size
                ? Math.max(...size.sizes)
                : 0;
          if (full > MAX_MEDIA_BYTES)
            throw new AdapterError(
              "INVALID_OPTIONS",
              "Медиа Telegram превышает допустимый размер.",
            );
        }
      }
      const control = new AbortController();
      const data = await client.downloadMedia(message, {
        signal: AbortSignal.any([this.context!.signal, control.signal]),
        progressCallback: (received, total) => {
          if (
            BigInt(received.toString()) > BigInt(MAX_MEDIA_BYTES) ||
            BigInt(total.toString()) > BigInt(MAX_MEDIA_BYTES)
          ) {
            exceededLimit = true;
            control.abort();
            throw new Error("MEDIA_TOO_LARGE");
          }
        },
      });
      this.queueSession();
      await this.writes;
      if (data === undefined || (data instanceof Uint8Array && !data.length))
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Медиа Telegram больше недоступно.",
        );
      if (data instanceof Uint8Array && data.length > MAX_MEDIA_BYTES)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Медиа Telegram превышает допустимый размер.",
        );
      if (!(data instanceof Uint8Array)) throw new Error("INVALID_MEDIA");
      return {
        data: new Uint8Array(data),
        mimeType: attachment.mimeType ?? "application/octet-stream",
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      };
    } catch (error) {
      if (exceededLimit)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Медиа Telegram превышает допустимый размер.",
        );
      if (error instanceof AdapterError) throw error;
      if (
        error instanceof FileReferenceExpiredError ||
        error instanceof FileReferenceInvalidError ||
        error instanceof FileIdInvalidError
      )
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Ссылка медиа Telegram больше недействительна.",
        );
      throw new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось скачать медиа Telegram.",
      );
    }
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
    this.dialogIds.clear();
    this.dialogLoad = undefined;
    try {
      if (client) await client.destroy();
    } finally {
      await this.writes;
    }
  }
}
