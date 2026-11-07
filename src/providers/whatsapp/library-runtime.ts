import makeWASocket, {
  downloadMediaMessage,
  normalizeMessageContent,
  jidNormalizedUser,
  proto,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import {
  MAX_MEDIA_BYTES,
  collectMedia,
  decodeMediaReference,
  mediaFileName,
  validateMedia,
} from "../../library/media.js";
import type {
  MediaInput,
  MediaFile,
  AvatarTarget,
  DriverContext,
} from "../../library/types.js";
import { AdapterError, abortable } from "../../library/errors.js";
import { createWhatsAppAuthState } from "./session-storage.js";
import { WhatsAppCatalog } from "./catalog.js";
import { isChatId, normalizeMessage } from "./normalize.js";
import { connectionOptions } from "./connection.js";
import { hasSession } from "./auth.js";

export class WhatsAppLibraryRuntime {
  private socket?: WASocket;
  private auth?: Awaited<ReturnType<typeof createWhatsAppAuthState>>;
  private historyAnchors = new Map<string, WAMessage>();
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
    private downloadMessage: typeof downloadMediaMessage = downloadMediaMessage,
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
    socket.ev.on("messages.update", (updates) => {
      if (this.socket !== socket || this.stopped || this.fault) return;
      for (const { key, update } of updates) {
        if (!key.fromMe || !key.id) continue;
        const status = update.status;
        if (
          status !== proto.WebMessageInfo.Status.DELIVERY_ACK &&
          status !== proto.WebMessageInfo.Status.READ &&
          status !== proto.WebMessageInfo.Status.PLAYED
        )
          continue;
        const chatIds = new Set(
          [key.remoteJid, key.remoteJidAlt]
            .filter((id): id is string => !!id)
            .map(jidNormalizedUser),
        );
        for (const chatId of chatIds) {
          if (!isChatId(chatId) || chatId.endsWith("@g.us")) continue;
          context.onReceipt?.({
            provider: "whatsapp",
            accountId: this.accountId,
            chatId,
            messageIds: [`${chatId}:${key.id}`],
            status:
              status === proto.WebMessageInfo.Status.DELIVERY_ACK
                ? "delivered"
                : "read",
          });
        }
      }
    });
    socket.ev.on("messaging-history.set", (data) => {
      this.catalog.chats(data.chats);
      this.catalog.contacts(data.contacts);
      this.catalog.mappings(data.lidPnMappings ?? []);
      for (const message of data.messages) {
        this.catalog.observe(message);
        this.observeHistoryAnchor(message);
      }
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
        this.observeHistoryAnchor(item);
        if (data.type !== "notify") continue;
        const message = normalizeMessage(item, this.accountId);
        if (message) context.onMessage(message);
      }
    });
  }

  private observeHistoryAnchor(message: WAMessage) {
    const chat = jidNormalizedUser(message.key.remoteJid ?? undefined);
    const timestamp = Number(message.messageTimestamp);
    if (
      !isChatId(chat) ||
      !message.key.id ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0
    )
      return;
    const previous = this.historyAnchors.get(chat);
    if (!previous || Number(previous.messageTimestamp) < timestamp)
      this.historyAnchors.set(chat, message);
  }

  async listHistoryPage(
    chatId: string,
    { limit, cursor }: { limit: number; cursor?: string },
  ) {
    this.requireConnection();
    const socket = this.socket!;
    const first = cursor ? undefined : this.historyAnchors.get(chatId);
    let anchor: { id: string; jid: string; timestamp: number; fromMe: boolean };
    const asAnchor = (message: WAMessage) => ({
      id: message.key.id!,
      jid: message.key.remoteJid!,
      timestamp: Number(message.messageTimestamp),
      fromMe: Boolean(message.key.fromMe),
    });
    if (first) anchor = asAnchor(first);
    else if (cursor) {
      try {
        anchor = JSON.parse(cursor);
        if (
          typeof anchor.id !== "string" ||
          !anchor.id ||
          typeof anchor.jid !== "string" ||
          jidNormalizedUser(anchor.jid) !== chatId ||
          typeof anchor.fromMe !== "boolean" ||
          !Number.isSafeInteger(anchor.timestamp) ||
          anchor.timestamp <= 0
        )
          throw new Error();
      } catch {
        throw new AdapterError(
          "INVALID_OPTIONS",
          "Некорректный курсор WhatsApp.",
        );
      }
    } else {
      throw new AdapterError(
        "UNSUPPORTED_OPERATION",
        "WhatsApp ещё не передал исходное сообщение диалога.",
      );
    }

    const initial = first && normalizeMessage(first, this.accountId, true);
    const messages = initial ? [initial] : [];
    if (messages.length === limit)
      return { messages, nextCursor: JSON.stringify(anchor) };

    type HistoryEvent = BaileysEventMap["messaging-history.set"];
    const early = new Map<string, WAMessage[]>();
    let requestId: string | undefined;
    let resolve!: (items: WAMessage[]) => void;
    const reply = new Promise<WAMessage[]>((done) => {
      resolve = done;
    });
    const receive = (event: HistoryEvent) => {
      const id = event.peerDataRequestSessionId;
      if (event.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND || !id)
        return;
      if (id === requestId) resolve(event.messages);
      else if (!requestId && early.size < 4) early.set(id, event.messages);
    };
    socket.ev.on("messaging-history.set", receive);
    const timeout = AbortSignal.timeout(25_000);
    try {
      const signal = this.context
        ? AbortSignal.any([timeout, this.context.signal])
        : timeout;
      requestId = await abortable(
        socket.fetchMessageHistory(
          Math.min(50, limit - messages.length),
          { id: anchor.id, remoteJid: anchor.jid, fromMe: anchor.fromMe },
          anchor.timestamp * 1000,
        ),
        signal,
      );
      const older = (early.get(requestId) ?? (await abortable(reply, signal)))
        .filter(
          (message) =>
            jidNormalizedUser(message.key.remoteJid ?? undefined) === chatId &&
            message.key.id &&
            message.key.id !== anchor.id &&
            Number(message.messageTimestamp) > 0 &&
            Number(message.messageTimestamp) <= anchor.timestamp,
        )
        .sort(
          (a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp),
        );
      for (const message of older) {
        const normalized = normalizeMessage(message, this.accountId, true);
        if (normalized) messages.push(normalized);
      }
      const oldest = older.at(-1);
      return {
        messages,
        nextCursor: oldest ? JSON.stringify(asAnchor(oldest)) : undefined,
      };
    } catch (error) {
      if (timeout.aborted && !this.context?.signal.aborted)
        throw new AdapterError(
          "PROVIDER_ERROR",
          "WhatsApp не ответил на запрос истории.",
        );
      throw error;
    } finally {
      socket.ev.off("messaging-history.set", receive);
    }
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

  async avatarUrl(target: AvatarTarget): Promise<string | undefined> {
    this.requireConnection();
    if (!isChatId(target.id))
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректный ID аватара WhatsApp.",
      );
    try {
      const url = await this.socket!.profilePictureUrl(target.id, "preview");
      await this.credentials;
      await this.auth!.flush();
      this.requireConnection();
      return url;
    } catch (error) {
      await this.credentials;
      await this.auth!.flush();
      this.requireConnection();
      const status = (error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;
      if (status === 404 || status === 410) return undefined;
      throw new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось получить аватар WhatsApp.",
      );
    }
  }

  async sendMedia(
    chatId: string,
    media: MediaInput,
  ): Promise<{ externalId: string }> {
    validateMedia(media);
    this.requireConnection();
    if (!isChatId(chatId))
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректный ID чата WhatsApp.",
      );
    if (media.kind === "audio" && media.caption)
      throw new AdapterError(
        "UNSUPPORTED_OPERATION",
        "WhatsApp не поддерживает подпись аудиофайла.",
      );
    try {
      const data = Buffer.from(media.data);
      const content =
        media.kind === "photo"
          ? { image: data, mimetype: media.mimeType, caption: media.caption }
          : media.kind === "video"
            ? { video: data, mimetype: media.mimeType, caption: media.caption }
            : {
                audio: data,
                mimetype: media.mimeType,
                ptt: false,
                fileName: mediaFileName(media),
              };
      const result = await this.socket!.sendMessage(chatId, content);
      await this.credentials;
      await this.auth!.flush();
      this.requireConnection();
      if (!result?.key.id) throw new Error("SEND_NOT_CONFIRMED");
      return { externalId: `${chatId}:${result.key.id}` };
    } catch (error) {
      await this.credentials;
      await this.auth!.flush();
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось отправить медиа WhatsApp.",
      );
    }
  }

  async downloadMedia(reference: string): Promise<MediaFile> {
    const payload = decodeMediaReference(reference, "whatsapp", this.accountId);
    if (typeof payload.message !== "string")
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа WhatsApp.",
      );
    this.requireConnection();
    let raw: proto.WebMessageInfo;
    try {
      raw = proto.WebMessageInfo.decode(Buffer.from(payload.message, "base64"));
    } catch {
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа WhatsApp.",
      );
    }
    if (
      !raw.key?.remoteJid ||
      !raw.key.id ||
      !isChatId(jidNormalizedUser(raw.key.remoteJid))
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа WhatsApp.",
      );
    const content = normalizeMessageContent(raw.message);
    const media =
      content?.imageMessage ??
      content?.videoMessage ??
      content?.audioMessage ??
      content?.documentMessage;
    if (!media)
      throw new AdapterError(
        "UNSUPPORTED_OPERATION",
        "Это вложение WhatsApp нельзя скачать как медиафайл.",
      );
    this.validateMediaLocation(media);
    if (
      media.fileLength != null &&
      BigInt(media.fileLength.toString()) > BigInt(MAX_MEDIA_BYTES)
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Медиа WhatsApp превышает допустимый размер.",
      );
    try {
      const stream = await this.downloadMessage(
        raw as WAMessage,
        "stream",
        { options: { signal: this.context!.signal } },
        {
          logger: pino({ level: "silent" }),
          reuploadRequest: async (message) => {
            const updated = await this.socket!.updateMediaMessage(message);
            const content = normalizeMessageContent(updated.message);
            const media =
              content?.imageMessage ??
              content?.videoMessage ??
              content?.audioMessage ??
              content?.documentMessage;
            if (!media) throw new Error("INVALID_MEDIA");
            this.validateMediaLocation(media);
            return updated;
          },
        },
      );
      const file = await collectMedia(
        stream,
        media.mimetype ?? "application/octet-stream",
        content?.documentMessage?.fileName ?? undefined,
      );
      await this.credentials;
      await this.auth!.flush();
      this.requireConnection();
      return file;
    } catch (error) {
      await this.credentials;
      await this.auth!.flush();
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось скачать медиа WhatsApp.",
      );
    }
  }

  private validateMediaLocation(media: {
    url?: string | null;
    directPath?: string | null;
  }): void {
    if (media.url) {
      let url: URL;
      try {
        url = new URL(media.url);
      } catch {
        throw new AdapterError(
          "INVALID_OPTIONS",
          "Некорректная ссылка медиа WhatsApp.",
        );
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443") ||
        !["whatsapp.net", "whatsapp.com", "fbcdn.net"].some(
          (host) => url.hostname === host || url.hostname.endsWith("." + host),
        )
      )
        throw new AdapterError(
          "INVALID_OPTIONS",
          "Некорректная ссылка медиа WhatsApp.",
        );
    }
    if (
      media.directPath &&
      (!media.directPath.startsWith("/") ||
        media.directPath.startsWith("//") ||
        /[\\\r\n]/.test(media.directPath))
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа WhatsApp.",
      );
    if (!media.url && !media.directPath)
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа WhatsApp.",
      );
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
