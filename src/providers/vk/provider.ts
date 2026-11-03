import { password } from "@inquirer/prompts";
import {
  API,
  APIError,
  Updates,
  Upload,
  getRandomId,
  type MessageContext,
} from "vk-io";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { Chat, Message, MessagingProvider } from "../../core/provider.js";
import { parseToken } from "./auth.js";
import { conversationChats, normalizeMessage } from "./normalize.js";
import { CancellableVkApi } from "./api.js";
import { loginWithVkQr } from "./qr.js";
import QRCode from "qrcode";

function vkError(error: unknown): Error {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === 5)
    return new Error(
      "Токен VK недействителен или отозван. Повторите login --provider=vk.",
    );
  if ([7, 15, 27, 1051].includes(code ?? 0))
    return new Error(
      `VK отказал в доступе (код ${code}). Нужен пользовательский токен приложения с доступом к личным сообщениям. Токен сообщества или обычный VK ID для этого не подходит.`,
    );
  if (typeof code === "number")
    return new Error(`Ошибка VK API (код ${code}).`);
  return new Error(
    "Не удалось выполнить запрос VK. Проверьте соединение и доступ к API.",
  );
}

export class VkProvider implements MessagingProvider {
  readonly kind = "vk";
  private vk?: { api: API; updates: Updates };
  private token = "";
  private authorized = false;
  private fault?: Error;
  private handlers = new Set<(message: Message) => void>();
  private errors = new Set<(error: Error) => void>();
  private stop = new AbortController();
  private polling?: Promise<void>;
  private closed = false;

  constructor(
    readonly accountId: string,
    private options: {
      sessionFile: string;
      token?: string;
      appId?: string;
      apiBaseUrl?: string;
    },
  ) {}

  private client(token: string): { api: API; updates: Updates } {
    const api = new CancellableVkApi(
      {
        token,
        apiVersion: "5.199",
        apiTimeout: 15_000,
        apiRetryLimit: 0,
        apiMode: "sequential",
        ...(this.options.apiBaseUrl
          ? { apiBaseUrl: this.options.apiBaseUrl }
          : {}),
      },
      () => this.stop.signal,
    );
    const vk = {
      api,
      updates: new Updates({ api, upload: new Upload({ api }) }),
    };
    vk.updates.on("message_new", async (context: MessageContext) => {
      if (context.isOutbox || context.isEvent) return;
      await context.loadMessagePayload();
      const message = normalizeMessage(context, this.accountId);
      if (message) for (const handler of this.handlers) handler(message);
    });
    return vk;
  }

  async connect(): Promise<void> {
    if (this.options.token) this.token = parseToken(this.options.token);
    else {
      try {
        this.token = parseToken(
          JSON.parse(await readFile(this.options.sessionFile, "utf8")).token,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (this.token) this.vk = this.client(this.token);
  }

  async login(options?: { method?: "phone" | "qr" }): Promise<void> {
    let state: string | undefined;
    if (options?.method === "qr") {
      const control = new AbortController();
      const abort = () => control.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        this.token = await loginWithVkQr({
          signal: control.signal,
          onStatus: (status) =>
            console.error(
              status === "code-entered"
                ? "Код введён. Ожидаю подтверждения VK…"
                : "Открываю переписку VK и получаю сессию…",
            ),
          requestCode: (signal) =>
            password(
              {
                message:
                  "Введите 6-значный код подтверждения из приложения VK:",
                mask: "*",
                validate: (value) =>
                  /^\d{6}$/.test(value) || "Введите ровно 6 цифр.",
              },
              { signal },
            ),
          onQr: async (value) => {
            console.error(
              "Отсканируйте QR камерой или сканером в приложении VK и подтвердите вход на телефоне.",
            );
            console.error(
              await QRCode.toString(value, { type: "terminal", small: true }),
            );
          },
        });
        this.vk = this.client(this.token);
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    } else if (!this.options.token) {
      if (this.options.appId) {
        if (!/^\d+$/.test(this.options.appId))
          throw new Error(
            "VK_APP_ID должен быть числовым ID вашего приложения.",
          );
        state = randomBytes(16).toString("hex");
        const url = new URL("https://oauth.vk.com/authorize");
        url.search = new URLSearchParams({
          client_id: this.options.appId,
          redirect_uri: "https://oauth.vk.com/blank.html",
          response_type: "token",
          display: "page",
          scope: "messages,offline",
          state,
          v: "5.199",
        }).toString();
        console.error(
          `Откройте ссылку авторизации своего приложения VK: ${url}`,
        );
      }
      this.token = parseToken(
        await password({
          message:
            "Пользовательский токен VK или полный адрес OAuth после подтверждения:",
          mask: "*",
        }),
        state,
      );
      this.vk = this.client(this.token);
    }
    this.authorized = false;
    await this.requireAuthorization();
    const file = this.options.sessionFile;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ token: this.token }), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async requireAuthorization(): Promise<void> {
    if (this.fault) throw this.fault;
    if (!this.vk)
      throw new Error(
        "Нет сессии VK. Выполните npm start -- login --provider=vk.",
      );
    if (this.authorized) return;
    try {
      const users = await this.vk.api.users.get({});
      if (users.length !== 1 || !users[0]?.id)
        throw new Error("USER_TOKEN_REQUIRED");
      await this.vk.api.messages.getConversations({ count: 1 });
      this.authorized = true;
    } catch (error) {
      if (error instanceof Error && error.message === "USER_TOKEN_REQUIRED")
        throw new Error("Для VK нужен токен личного аккаунта, не сообщества.");
      throw vkError(error);
    }
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

  subscribe(handler: (message: Message) => void): () => void {
    this.handlers.add(handler);
    if (!this.polling && !this.closed) this.startPolling();
    return () => {
      this.handlers.delete(handler);
      if (!this.handlers.size) this.stop.abort();
    };
  }

  private startPolling(): void {
    const control = new AbortController();
    this.stop = control;
    const task = this.poll(control.signal)
      .catch((error: unknown) => {
        if (control.signal.aborted) return;
        this.fault = vkError(error);
        for (const listener of this.errors) listener(this.fault);
      })
      .finally(() => {
        if (this.polling === task) this.polling = undefined;
        if (this.handlers.size && !this.closed && !this.fault)
          this.startPolling();
      });
    this.polling = task;
  }

  onError(handler: (error: Error) => void): () => void {
    this.errors.add(handler);
    if (this.fault) handler(this.fault);
    return () => {
      this.errors.delete(handler);
    };
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    this.stop.abort();
    await this.polling;
  }
}
