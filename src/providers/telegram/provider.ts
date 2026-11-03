import { input, password } from "@inquirer/prompts";
import { Api, TelegramClient, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { NewMessage, type NewMessageEvent } from "teleproto/events";
import { Logger, LogLevel } from "teleproto/extensions/Logger";
import type { Chat, Message, MessagingProvider } from "../../core/provider.js";
import { normalizeMessage } from "./normalize.js";
import { readSession, saveSession } from "./session.js";
import { codeDeliveryHint } from "./auth.js";
import QRCode from "qrcode";
import { telegramLoginUrl } from "./qr.js";

export interface TelegramOptions {
  apiId: number;
  apiHash: string;
  phone?: string;
  sessionFile: string;
}

export class TelegramProvider implements MessagingProvider {
  readonly kind = "telegram";
  private client!: TelegramClient;
  private session!: StringSession;

  constructor(
    readonly accountId: string,
    private options: TelegramOptions,
  ) {}

  async connect(): Promise<void> {
    this.session = new StringSession(
      await readSession(this.options.sessionFile),
    );
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
    await this.client.connect();
  }

  async login(options?: { method?: "phone" | "qr" }): Promise<void> {
    if (options?.method === "qr") {
      await this.loginWithQr();
    } else
      await this.client.start({
        phoneNumber: async () =>
          this.options.phone ||
          input({ message: "Номер телефона с кодом страны:" }),
        phoneCode: (viaApp, info) => {
          console.error(codeDeliveryHint(viaApp, info));
          return password({ message: "Код подтверждения:", mask: "*" });
        },
        password: () =>
          password({ message: "Пароль двухэтапной проверки:", mask: "*" }),
        emailAddress: () =>
          input({ message: "Email для подтверждения входа:" }),
        emailVerification: async () => ({
          type: "code",
          code: await password({ message: "Код из email:", mask: "*" }),
        }),
        onError: (error) => {
          throw error;
        },
      });
    await this.requireAuthorization();
    await saveSession(this.options.sessionFile, this.session.save());
  }

  private async loginWithQr(): Promise<void> {
    if (await this.client.checkAuthorization()) return;
    const stop = new AbortController();
    const abort = () => stop.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await this.client.signInUserWithQrCode(
        { apiId: this.options.apiId, apiHash: this.options.apiHash },
        {
          abortSignal: stop.signal,
          qrCode: async ({ token, expires }) => {
            console.error(
              "Telegram: Настройки → Устройства → Подключить устройство.",
            );
            console.error(
              await QRCode.toString(telegramLoginUrl(token), {
                type: "terminal",
                small: true,
              }),
            );
            console.error(
              `QR действует до ${new Date(expires * 1000).toLocaleTimeString("ru-RU")}. При истечении появится новый.`,
            );
          },
          password: () =>
            password(
              { message: "Пароль двухэтапной проверки:", mask: "*" },
              { signal: stop.signal },
            ),
          onError: (error) => {
            throw error;
          },
        },
      );
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }

  async requireAuthorization(): Promise<void> {
    if (!(await this.client.checkAuthorization())) {
      throw new Error(
        "Нет активной сессии. Сначала выполните npm start -- login.",
      );
    }
    const me = await this.client.getMe();
    if (me.bot) throw new Error("Требуется личный аккаунт Telegram.");
  }

  async disconnect(): Promise<void> {
    if (this.client) await this.client.destroy();
  }

  async listChats(): Promise<Chat[]> {
    await this.requireAuthorization();
    const chats: Chat[] = [];
    for await (const dialog of this.client.iterDialogs({})) {
      if (dialog.id)
        chats.push({ id: dialog.id.toString(), title: dialog.title ?? "" });
    }
    return chats;
  }

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<{ externalId: string }> {
    await this.requireAuthorization();
    const chats = await this.listChats();
    if (!chats.some((chat) => chat.id === chatId))
      throw new Error("Чат не найден. Возьмите ID из команды chats.");
    const message = await this.client.sendMessage(chatId, {
      message: text,
      parseMode: false,
    });
    return { externalId: `${chatId}:${message.id}` };
  }

  subscribe(handler: (message: Message) => void): () => void {
    const builder = new NewMessage({ incoming: true });
    const receive = async (event: NewMessageEvent) => {
      const message = normalizeMessage(event.message, this.accountId);
      if (message.chatId === "777000") return;
      const sender = event.message.sender;
      if (sender) {
        message.displayName = utils.getDisplayName(sender);
        if (sender instanceof Api.User || sender instanceof Api.Channel)
          message.username = sender.username;
      }
      handler(message);
    };
    this.client.addEventHandler(receive, builder);
    return () => this.client.removeEventHandler(receive, builder);
  }
}
