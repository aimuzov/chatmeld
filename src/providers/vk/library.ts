import {
  API,
  APIError,
  Updates,
  Upload,
  getRandomId,
  type MessageContext,
} from "vk-io";
import type {
  MediaInput,
  MediaFile,
  Avatar,
  AvatarTarget,
  Chat,
  DriverContext,
  ProviderDriver,
} from "../../library/types.js";
import { downloadAvatar } from "../../library/avatar.js";
import { readStored, writeStored } from "../../library/storage.js";
import { AdapterError, abortable } from "../../library/errors.js";
import {
  MAX_MEDIA_BYTES,
  decodeMediaReference,
  downloadMediaUrl,
  mediaFileName,
  validateMedia,
} from "../../library/media.js";
import {
  conversationChats,
  normalizeMessage,
  normalizeAttachments,
  vkDocumentMime,
} from "./normalize.js";
import { CancellableVkApi } from "./api.js";
import { loginWithVkQr } from "./qr.js";

function vkError(error: unknown): Error {
  if (error instanceof AdapterError) return error;
  const code = (error as { code?: number } | undefined)?.code;
  if (code === 5)
    return new AdapterError(
      "AUTH_REQUIRED",
      "Токен VK недействителен или отозван. Повторите авторизацию.",
    );
  if ([7, 15, 27, 1051].includes(code ?? 0))
    return new AdapterError(
      "PROVIDER_ERROR",
      `VK отказал в доступе (код ${code}). Нужен пользовательский токен приложения с доступом к личным сообщениям. Токен сообщества или обычный VK ID для этого не подходит.`,
    );
  if (typeof code === "number")
    return new AdapterError("PROVIDER_ERROR", `Ошибка VK API (код ${code}).`);
  return new AdapterError(
    "PROVIDER_ERROR",
    "Не удалось выполнить запрос VK. Проверьте соединение и доступ к API.",
  );
}

export function createVkDriver(options: { accountId: string }): ProviderDriver {
  return new VkDriver(options.accountId);
}

class VkDriver implements ProviderDriver {
  private vk?: { api: API; updates: Updates; upload: Upload };
  private context?: DriverContext;
  private stop = new AbortController();
  private polling?: Promise<void>;
  private removeAbort?: () => void;
  private fault?: Error;

  constructor(private accountId: string) {}

  private async open(
    context: DriverContext,
    authorize: boolean,
  ): Promise<void> {
    context.signal.throwIfAborted();
    this.context = context;
    this.fault = undefined;
    this.stop = new AbortController();
    const abort = () => this.stop.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    this.removeAbort = () => context.signal.removeEventListener("abort", abort);
    try {
      let token: string;
      if (authorize) {
        if (!context.auth)
          throw new AdapterError(
            "INVALID_STATE",
            "Не задан канал авторизации VK.",
          );
        token = await loginWithVkQr({
          signal: this.stop.signal,
          onQr: (value) => context.auth!.qr(value),
          requestCode: (signal) =>
            abortable(
              context.auth!.challenge({
                kind: "code",
                prompt: "Код подтверждения VK",
                pattern: "^\\d{6}$",
              }),
              signal,
            ),
          onStatus: (status) =>
            context.auth!.progress(
              status === "code-entered"
                ? "Ожидается подтверждение VK"
                : "Проверяется доступ к сообщениям VK",
            ),
        });
      } else {
        const stored = await readStored<{ token: string }>(
          context.storage,
          "vk/token",
        );
        if (!stored)
          throw new AdapterError("AUTH_REQUIRED", "Нет сохранённой сессии VK.");
        if (typeof stored.token !== "string" || !stored.token)
          throw new AdapterError("STORAGE_ERROR", "Некорректная сессия VK.");
        token = stored.token;
      }
      const api = new CancellableVkApi(
        {
          token,
          apiVersion: "5.199",
          apiTimeout: 15000,
          apiRetryLimit: 0,
          apiMode: "sequential",
        },
        () => this.stop.signal,
      );
      const upload = new Upload({ api });
      this.vk = { api, upload, updates: new Updates({ api, upload }) };
      const users = await api.users.get({});
      if (users.length !== 1 || !users[0]?.id)
        throw new AdapterError("AUTH_REQUIRED", "Для VK нужен личный аккаунт.");
      await api.messages.getConversations({ count: 1 });
      context.signal.throwIfAborted();
      if (authorize) await writeStored(context.storage, "vk/token", { token });
      this.vk.updates.on(
        "message_new",
        async (messageContext: MessageContext) => {
          if (
            this.stop.signal.aborted ||
            messageContext.isOutbox ||
            messageContext.isEvent
          )
            return;
          await messageContext.loadMessagePayload();
          const message = normalizeMessage(messageContext, this.accountId);
          if (message) context.onMessage(message);
        },
      );
      this.vk.updates.on("messages_read", (event) => {
        if (
          this.stop.signal.aborted ||
          !event.isOutbox ||
          event.peerId <= 0 ||
          event.peerId >= 2_000_000_000
        )
          return;
        const chatId = String(event.peerId);
        context.onReceipt?.({
          provider: "vk",
          accountId: this.accountId,
          chatId,
          status: "read",
          throughMessageId: `${chatId}:${event.localId}`,
        });
      });
      const signal = this.stop.signal;
      this.polling = this.poll(signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.fault = vkError(error);
          this.stop.abort();
          context.onError(this.fault);
        }
      });
    } catch (error) {
      await this.disconnect();
      if (context.signal.aborted) context.signal.throwIfAborted();
      throw vkError(error);
    }
  }

  connect(context: DriverContext): Promise<void> {
    return this.open(context, false);
  }
  authorize(context: DriverContext): Promise<void> {
    return this.open(context, true);
  }

  private async requireAuthorization(): Promise<void> {
    if (this.fault) throw this.fault;
    if (!this.vk) throw new Error("VK не подключён.");
    this.stop.signal.throwIfAborted();
  }

  async listChats(): Promise<Chat[]> {
    await this.requireAuthorization();
    const chats = new Map<string, Chat>();
    try {
      for (let offset = 0; ; offset += 200) {
        const page = await this.vk!.api.messages.getConversations({
          offset,
          count: 200,
          extended: 1,
          filter: "all",
        });
        for (const chat of conversationChats(page)) chats.set(chat.id, chat);
        if (!page.items.length || offset + page.items.length >= page.count)
          break;
      }
      return [...chats.values()];
    } catch (error) {
      throw vkError(error);
    }
  }

  async getAvatar(target: AvatarTarget): Promise<Avatar | undefined> {
    const id = Number(target.id);
    if (
      !/^-?\d+$/.test(target.id) ||
      !Number.isSafeInteger(id) ||
      id === 0 ||
      (target.type === "user" && (id < 0 || id >= 2_000_000_000))
    )
      throw new AdapterError("INVALID_OPTIONS", "Некорректный ID аватара VK.");
    await this.requireAuthorization();
    try {
      let url: string | undefined;
      const api = this.vk!.api;
      if (id >= 2_000_000_000) {
        const page = await api.messages.getConversationsById({
          peer_ids: [id],
        });
        url = page.items.find((item) => item.peer.id === id)?.chat_settings
          ?.photo?.photo_100;
      } else if (id < 0) {
        const page = await api.groups.getById({
          group_ids: [String(-id)],
          fields: ["photo_100"],
        });
        url = page.groups.find((group) => group.id === -id)?.photo_100;
      } else {
        const users = await api.users.get({
          user_ids: [String(id)],
          fields: ["photo_100"],
        });
        url = users.find((user) => user.id === id)?.photo_100;
      }
      if (
        url &&
        /\/images\/(?:camera|community)(?:_|\.)/.test(new URL(url).pathname)
      )
        return undefined;
      return await downloadAvatar(
        url,
        [
          "userapi.com",
          "vkuserphoto.ru",
          "vkuserphoto.net",
          "vk-cdn.net",
          "vkuser.net",
        ],
        this.stop.signal,
      );
    } catch (error) {
      throw vkError(error);
    }
  }

  async listMessages(chatId: string, options: { limit?: number } = {}) {
    if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(Number(chatId)))
      throw new AdapterError("INVALID_OPTIONS", "Некорректный ID чата VK.");
    await this.requireAuthorization();
    try {
      const page = await this.vk!.api.messages.getHistory({
        peer_id: Number(chatId),
        count: options.limit ?? 100,
        extended: 1,
      });
      const names = new Map<number, string>(
        (
          (page.profiles ?? []) as {
            id: number;
            first_name?: string;
            last_name?: string;
          }[]
        ).map((user) => [
          user.id,
          [user.first_name, user.last_name].filter(Boolean).join(" "),
        ]),
      );
      return page.items.map((message) => ({
        provider: "vk" as const,
        accountId: this.accountId,
        chatId,
        messageId: `${chatId}:${message.conversation_message_id ?? message.id}`,
        senderId: String(message.from_id),
        displayName: names.get(message.from_id),
        direction: message.out ? ("outgoing" as const) : ("incoming" as const),
        text: message.text ?? "",
        sentAt: new Date(message.date * 1000).toISOString(),
        attachments: normalizeAttachments(
          message.attachments ?? [],
          chatId,
          message.conversation_message_id,
          this.accountId,
        ),
      }));
    } catch (error) {
      throw vkError(error);
    }
  }

  async sendMedia(
    chatId: string,
    media: MediaInput,
  ): Promise<{ externalId: string }> {
    validateMedia(media);
    const peer = Number(chatId);
    if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(peer) || !peer)
      throw new AdapterError("INVALID_OPTIONS", "Некорректный ID чата VK.");
    await this.requireAuthorization();
    try {
      const source = {
        value: Buffer.from(media.data),
        filename: mediaFileName(media),
        contentType: media.mimeType,
      };
      const upload = this.vk!.upload;
      const attachment =
        media.kind === "photo"
          ? await upload.messagePhoto({ peer_id: peer, source })
          : media.kind === "video"
            ? await upload.video({
                source,
                is_private: 1,
                name: mediaFileName(media),
              })
            : await upload.messageDocument({
                peer_id: peer,
                source,
                title: mediaFileName(media),
              });
      const [result] = await this.vk!.api.messages.send({
        peer_ids: [peer],
        random_id: getRandomId(),
        attachment: attachment.toString(),
        message: media.caption ?? "",
      });
      if (result?.error)
        throw new APIError({ ...result.error, request_params: [] });
      if (!result?.conversation_message_id)
        throw new Error("SEND_NOT_CONFIRMED");
      return { externalId: `${chatId}:${result.conversation_message_id}` };
    } catch (error) {
      throw vkError(error);
    }
  }

  async downloadMedia(reference: string): Promise<MediaFile> {
    const value = decodeMediaReference(reference, "vk", this.accountId);
    if (
      typeof value.chatId !== "string" ||
      !/^-?\d+$/.test(value.chatId) ||
      !Number.isSafeInteger(Number(value.chatId)) ||
      !Number(value.chatId) ||
      !Number.isSafeInteger(value.conversationMessageId) ||
      Number(value.conversationMessageId) <= 0 ||
      !Number.isSafeInteger(value.index) ||
      Number(value.index) < 0
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Некорректная ссылка медиа VK.",
      );
    await this.requireAuthorization();
    try {
      const page = await this.vk!.api.messages.getByConversationMessageId({
        peer_id: Number(value.chatId),
        conversation_message_ids: [Number(value.conversationMessageId)],
      });
      const message = page.items.find(
        (item) =>
          item.conversation_message_id === value.conversationMessageId &&
          item.peer_id === Number(value.chatId),
      );
      const attachment =
        value.attachmentType && typeof value.attachmentId === "number"
          ? message?.attachments?.find((item) => {
              if (item.type !== value.attachmentType) return false;
              const raw = (item as Record<string, unknown>)[item.type] as
                { id?: number; owner_id?: number } | undefined;
              return (
                raw?.id === value.attachmentId &&
                raw?.owner_id === value.ownerId
              );
            })
          : message?.attachments?.[Number(value.index)];
      if (!attachment)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Сообщение или медиа VK больше недоступно.",
        );
      let url: string | undefined,
        mimeType: string | undefined,
        fileName: string | undefined;
      if (attachment.type === "photo") {
        const sizes = attachment.photo?.sizes ?? [];
        url = [...sizes].sort(
          (a, b) => b.width * b.height - a.width * a.height,
        )[0]?.url;
        mimeType = "image/jpeg";
      } else if (attachment.type === "audio_message") {
        url =
          attachment.audio_message?.link_ogg ??
          attachment.audio_message?.link_mp3;
        mimeType = attachment.audio_message?.link_ogg
          ? "audio/ogg"
          : "audio/mpeg";
      } else if (attachment.type === "audio") {
        url = attachment.audio?.url;
        mimeType = "audio/mpeg";
      } else if (attachment.type === "doc") {
        const doc = attachment.doc;
        if (doc?.size && doc.size > MAX_MEDIA_BYTES)
          throw new AdapterError(
            "INVALID_OPTIONS",
            "Медиа VK превышает допустимый размер.",
          );
        url = doc?.url;
        mimeType = vkDocumentMime(doc?.ext);
        fileName = doc?.title;
        if (!mimeType)
          throw new AdapterError(
            "UNSUPPORTED_OPERATION",
            "Документ VK не является поддерживаемым медиафайлом.",
          );
      } else if (attachment.type === "video") {
        const video = attachment.video;
        if (!video)
          throw new AdapterError(
            "UNSUPPORTED_OPERATION",
            "Сообщение или медиа VK больше недоступно.",
          );
        const response = await this.vk!.api.video.get({
          videos: [
            `${video.owner_id}_${video.id}${video.access_key ? "_" + video.access_key : ""}`,
          ],
        });
        const files = response.items[0]?.files;
        if (files) {
          const key = Object.keys(files)
            .filter((key) => /^mp4_\d+$/.test(key))
            .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))[0];
          url = key ? (files as Record<string, string>)[key] : undefined;
        }
        mimeType = "video/mp4";
        if (!url)
          throw new AdapterError(
            "UNSUPPORTED_OPERATION",
            "VK не предоставляет доступный для скачивания видеофайл.",
          );
      } else
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Это вложение VK не поддерживает скачивание.",
        );
      if (!url)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Сообщение или медиа VK больше недоступно.",
        );
      const host = new URL(url).hostname;
      const allowed = [
        "userapi.com",
        "vkuser.net",
        "vkuseraudio.net",
        "vkuseraudio.com",
        "vkuserphoto.ru",
        "vkuserphoto.net",
        "vk-cdn.net",
      ];
      if (/^vkvd\d+\.mycdn\.me$/.test(host)) allowed.push(host);
      return await downloadMediaUrl(url, allowed, {
        signal: this.stop.signal,
        mimeType,
        fileName,
      });
    } catch (error) {
      throw vkError(error);
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<{ externalId: string }> {
    if (
      !/^-?\d+$/.test(chatId) ||
      !Number.isSafeInteger(Number(chatId)) ||
      Number(chatId) === 0 ||
      !text.trim()
    )
      throw new Error("Укажите ID чата VK из chats и непустой текст.");
    await this.requireAuthorization();
    try {
      const [message] = await this.vk!.api.messages.send({
        peer_ids: [Number(chatId)],
        random_id: getRandomId(),
        message: text,
      });
      if (message?.error)
        throw new APIError({ ...message.error, request_params: [] });
      if (!message?.conversation_message_id)
        throw new Error("SEND_NOT_CONFIRMED");
      return { externalId: `${chatId}:${message.conversation_message_id}` };
    } catch (error) {
      throw vkError(error);
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let server: { url: URL; ts: string } | undefined;
    let resets = 0;
    while (!signal.aborted) {
      if (!server) {
        const value = await this.vk!.api.messages.getLongPollServer({
          lp_version: 19,
        });
        const url = new URL(
          value.server.startsWith("https://")
            ? value.server
            : `https://${value.server}`,
        );
        if (url.protocol !== "https:") throw new Error("INVALID_LONG_POLL_URL");
        url.search = new URLSearchParams({
          act: "a_check",
          key: value.key,
          wait: "25",
          mode: "202",
          version: "19",
        }).toString();
        server = { url, ts: String(value.ts) };
      }
      server.url.searchParams.set("ts", server.ts);
      const response = await fetch(server.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      });
      if (!response.ok) throw new Error("LONG_POLL_HTTP_ERROR");
      const data = (await response.json()) as {
        ts?: number | string;
        failed?: number;
        updates?: unknown[][];
      };
      if (data.failed === 2 || data.failed === 3) {
        if (++resets > 3) throw new Error("LONG_POLL_RESTART_LIMIT");
        server = undefined;
        continue;
      }
      if (data.ts === undefined || (data.failed && data.failed !== 1))
        throw new Error("LONG_POLL_INVALID_RESPONSE");
      if (!data.failed) {
        if (!Array.isArray(data.updates))
          throw new Error("LONG_POLL_INVALID_UPDATES");
        for (const update of data.updates) {
          if (signal.aborted) return;
          await this.vk!.updates.handlePollingUpdate(update);
        }
        resets = 0;
      }
      server.ts = String(data.ts);
    }
  }

  async disconnect(): Promise<void> {
    this.removeAbort?.();
    this.removeAbort = undefined;
    this.stop.abort();
    await this.polling;
    this.polling = undefined;
    this.vk = undefined;
  }
}
