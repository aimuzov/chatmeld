import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WhatsAppCatalog } from "./catalog.js";
import { isChatId, normalizeMessage } from "./normalize.js";
import type { Message } from "../../core/provider.js";
import { hasSession } from "./auth.js";
import { connectionOptions } from "./connection.js";

export class WhatsAppRuntime {
  private socket?: WASocket;
  private state?: Awaited<ReturnType<typeof useMultiFileAuthState>>;
  private catalog = new WhatsAppCatalog();
  private directory = "";
  private accountId = "";
  private opening?: Promise<void>;
  private resolveOpen?: () => void;
  private rejectOpen?: (error: Error) => void;
  private ready = false;
  private fault?: Error;
  private stopping = new AbortController();
  private credentialWrites = Promise.resolve();
  private catalogWrites = Promise.resolve();
  private listening = false;
  private backlog: Message[] = [];
  private namesSynced = false;

  constructor(private emit: (event: Record<string, unknown>) => void) {}

  private fail(error: Error): void {
    if (this.fault || this.stopping.signal.aborted) return;
    this.fault = error;
    this.rejectOpen?.(error);
    this.emit({ event: "fatal", error: error.message });
  }

  private saveCatalog(): void {
    this.catalogWrites = this.catalogWrites
      .then(async () => {
        const file = join(this.directory, "catalog.json");
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(this.catalog.snapshot()), {
          mode: 0o600,
        });
        await rename(temporary, file);
      })
      .catch((error: Error) => this.fail(error));
  }

  private async initialize(params: {
    sessionDir: string;
    accountId: string;
  }): Promise<void> {
    if (this.state) return;
    this.directory = params.sessionDir;
    this.accountId = params.accountId;
    process.umask(0o077);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const file of await readdir(this.directory))
      if (file.endsWith(".json"))
        await chmod(join(this.directory, file), 0o600);
    try {
      this.catalog.restore(
        JSON.parse(
          await readFile(join(this.directory, "catalog.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.state = await useMultiFileAuthState(this.directory);
  }

  private async ensureOpen(
    params: { sessionDir: string; accountId: string },
    allowQr: boolean,
  ): Promise<void> {
    await this.initialize(params);
    if (this.fault) throw this.fault;
    if (this.ready) return;
    if (!allowQr && !hasSession(this.state!.state.creds))
      throw new Error(
        "Нет сессии WhatsApp. Выполните npm start -- login --provider=whatsapp --qr.",
      );
    if (!this.opening) {
      this.opening = new Promise<void>((resolve, reject) => {
        this.resolveOpen = resolve;
        this.rejectOpen = reject;
      });
      const timer = setTimeout(
        () =>
          this.fail(new Error("WhatsApp: истекло время ожидания подключения.")),
        allowQr ? 120_000 : 30_000,
      );
      this.opening = this.opening.finally(() => clearTimeout(timer));
      try {
        this.openSocket(allowQr, 0);
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("Ошибка подключения WhatsApp"),
        );
      }
    }
    await this.opening;
  }

  private openSocket(allowQr: boolean, restarts: number): void {
    const socket = makeWASocket({
      auth: this.state!.state,
      logger: pino({ level: "silent" }),
      ...connectionOptions(),
    });
    this.socket = socket;
    socket.ev.on("creds.update", (update) => {
      this.credentialWrites = this.credentialWrites
        .then(() => this.state!.saveCreds())
        .catch((error: Error) => this.fail(error));
      if (update.myAppStateKeyId && this.ready)
        void this.syncNames().catch((error: Error) => this.fail(error));
    });
    socket.ev.on("connection.update", (update) => {
      void (async () => {
        if (this.socket !== socket || this.stopping.signal.aborted) return;
        if (update.qr) {
          if (!allowQr) {
            this.fail(
              new Error(
                "Сессия WhatsApp недействительна. Выполните login --provider=whatsapp --qr.",
              ),
            );
            return;
          }
          this.emit({ event: "qr", value: update.qr });
        }
        if (update.connection === "open") {
          this.ready = true;
          this.resolveOpen?.();
        }
        if (update.connection === "close") {
          this.ready = false;
          const error = update.lastDisconnect?.error as
            (Error & { output?: { statusCode?: number } }) | undefined;
          const status = error?.output?.statusCode;
          const reason = error?.message?.replace(/[\r\n]+/g, " ").slice(0, 200);
          if (status === DisconnectReason.restartRequired && restarts < 3) {
            await this.credentialWrites;
            if (!this.stopping.signal.aborted && !this.fault)
              this.openSocket(allowQr, restarts + 1);
          } else
            this.fail(
              new Error(
                status === DisconnectReason.loggedOut
                  ? "Сессия WhatsApp отозвана. Выполните login --provider=whatsapp --qr с новой папкой сессии."
                  : `Соединение WhatsApp закрыто (код ${status ?? "неизвестен"})${reason ? `: ${reason}` : ""}. Запустите команду заново.`,
              ),
            );
        }
      })().catch((error: Error) => this.fail(error));
    });
    socket.ev.on("messaging-history.set", (data) => {
      this.catalog.chats(data.chats);
      this.catalog.contacts(data.contacts);
      this.catalog.mappings(data.lidPnMappings ?? []);
      for (const message of data.messages) this.catalog.observe(message);
      this.saveCatalog();
    });
    socket.ev.on("chats.upsert", (chats) => {
      this.catalog.chats(chats);
      this.saveCatalog();
    });
    socket.ev.on("chats.update", (chats) => {
      this.catalog.chats(chats);
      this.saveCatalog();
    });
    socket.ev.on("chats.delete", (ids) => {
      this.catalog.remove(ids);
      this.saveCatalog();
    });
    socket.ev.on("contacts.upsert", (contacts) => {
      this.catalog.contacts(contacts);
      this.saveCatalog();
    });
    socket.ev.on("contacts.update", (contacts) => {
      this.catalog.contacts(contacts);
      this.saveCatalog();
    });
    socket.ev.on("lid-mapping.update", (mapping) => {
      this.catalog.mappings([mapping]);
      this.saveCatalog();
    });
    socket.ev.on("messages.upsert", (data) => {
      for (const message of data.messages) {
        this.catalog.observe(message);
        if (data.type !== "notify") continue;
        const normalized = normalizeMessage(message, this.accountId);
        if (!normalized) continue;
        if (this.listening)
          this.emit({ event: "message", message: normalized });
        else if (this.backlog.length < 100) this.backlog.push(normalized);
        else this.fail(new Error("Переполнен буфер входящих WhatsApp."));
      }
      this.saveCatalog();
    });
  }

  private async waitForCatalog(): Promise<void> {
    const deadline = Date.now() + 25_000;
    while (
      !this.stopping.signal.aborted &&
      Date.now() < deadline &&
      (this.socket?.ev.isBuffering() || !this.catalog.hasNamedPeople())
    ) {
      try {
        await delay(100, undefined, { signal: this.stopping.signal });
      } catch (error) {
        if (!this.stopping.signal.aborted) throw error;
      }
    }
    if (!this.catalog.list().length)
      this.emit({
        event: "notice",
        text: "WhatsApp пока не прислал список чатов. Оставьте listen запущенным для синхронизации.",
      });
    else if (!this.catalog.hasNamedPeople())
      this.emit({
        event: "notice",
        text: "WhatsApp ещё не прислал имена контактов. listen продолжит принимать обновления.",
      });
  }

  private async syncNames(): Promise<void> {
    if (this.namesSynced) return;
    if (!this.state?.state.creds.myAppStateKeyId) return;
    this.namesSynced = true;
    this.emit({ event: "notice", text: "Загружаю имена контактов WhatsApp…" });
    await this.socket!.resyncAppState(["critical_unblock_low"], true);
    await this.waitForCatalog();
    if (this.catalog.hasNamedPeople())
      this.emit({
        event: "notice",
        text: "Имена контактов WhatsApp загружены.",
      });
    this.saveCatalog();
  }

  async command(
    method: string,
    params: {
      sessionDir: string;
      accountId: string;
      chatId?: string;
      text?: string;
    },
  ): Promise<unknown> {
    if (method === "ping") return { ok: true };
    if (method === "chats") {
      try {
        this.catalog.restore(
          JSON.parse(
            await readFile(join(params.sessionDir, "catalog.json"), "utf8"),
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(
          "Нет каталога WhatsApp. Выполните login --provider=whatsapp --qr, затем listen --provider=whatsapp.",
        );
      }
      if (!this.catalog.hasNamedPeople())
        this.emit({
          event: "notice",
          text: "Имена ещё не синхронизированы. Запустите listen --provider=whatsapp и дождитесь загрузки контактов.",
        });
      return this.catalog.list();
    }
    await this.ensureOpen(params, method === "login");
    if (method === "login" || method === "authorize") await this.syncNames();
    if (method === "login") await this.waitForCatalog();
    if (method === "send") {
      if (!params.chatId || !isChatId(params.chatId) || !params.text?.trim())
        throw new Error("Укажите ID чата WhatsApp из chats и непустой текст.");
      const message = await this.socket!.sendMessage(params.chatId, {
        text: params.text,
      });
      if (!message?.key.id)
        throw new Error("WhatsApp не подтвердил отправку сообщения.");
      return { externalId: `${params.chatId}:${message.key.id}` };
    }
    if (method === "listen") {
      this.listening = true;
      for (const message of this.backlog.splice(0))
        this.emit({ event: "message", message });
    } else if (method === "unlisten") this.listening = false;
    else if (!["login", "authorize"].includes(method))
      throw new Error(`Неизвестный метод: ${method}`);
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.stopping.signal.aborted) return;
    this.stopping.abort();
    this.rejectOpen?.(new Error("Вход WhatsApp отменён."));
    await this.socket?.end(undefined);
    await this.credentialWrites;
    await this.catalogWrites;
  }
}
