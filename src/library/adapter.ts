import { AuthFlow } from "./auth.js";
import { SerializedStorage } from "./storage.js";
import { validateMedia, decodeMediaReference } from "./media.js";
import { AdapterError, abortable, cancelled, safeError } from "./errors.js";
import type {
  AdapterOptions,
  AvatarTarget,
  MediaInput,
  AdapterState,
  AuthEvent,
  DriverContext,
  Message,
  MessageReceipt,
  MessagingAdapter,
  ProviderDriver,
} from "./types.js";

export class Adapter implements MessagingAdapter {
  readonly provider: AdapterOptions["provider"];
  readonly accountId: string;
  private driver?: ProviderDriver;
  private control?: AbortController;
  private auth?: AuthFlow;
  private operation?: Promise<void>;
  private busy = false;
  private connected = false;
  private fault?: AdapterError;
  private closing?: Promise<void>;
  private driverClosing = false;
  private disconnecting?: Promise<void>;
  private storage?: SerializedStorage;
  private messages = new Set<(message: Message) => void | Promise<void>>();
  private receipts = new Set<
    (receipt: MessageReceipt) => void | Promise<void>
  >();
  private states = new Set<(state: AdapterState) => void>();
  private queue = { delivery: Promise.resolve(), queued: 0 };
  private closingRequested = false;

  constructor(
    private options: AdapterOptions,
    private factory: () => Promise<ProviderDriver>,
  ) {
    this.provider = options.provider;
    this.accountId = options.accountId;
    if (
      !options.accountId?.trim() ||
      typeof options.storage?.read !== "function" ||
      typeof options.storage?.writeBatch !== "function"
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Нужны идентификатор аккаунта и хранилище сессии.",
      );
    if (
      !["telegram", "vk", "max", "whatsapp", "instagram"].includes(
        options.provider,
      )
    )
      throw new AdapterError("INVALID_OPTIONS", "Неизвестный мессенджер.");
    if (
      options.provider === "instagram" &&
      (typeof options.username !== "string" ||
        !/^[a-zA-Z0-9._]{1,30}$/.test(options.username))
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Для Instagram нужен username без @.",
      );
    if (
      options.provider === "telegram" &&
      (!Number.isSafeInteger(options.apiId) ||
        options.apiId <= 0 ||
        !options.apiHash?.trim())
    )
      throw new AdapterError(
        "INVALID_OPTIONS",
        "Для Telegram нужны apiId и apiHash.",
      );
  }

  private state(state: AdapterState): void {
    for (const handler of this.states) {
      try {
        handler(state);
      } catch {
        this.states.delete(handler);
        if (state.state !== "error")
          this.fail(
            new AdapterError(
              "HANDLER_ERROR",
              "Ошибка обработчика состояния подключения.",
            ),
          );
      }
    }
  }
  private closeDriver(): Promise<void> {
    if (!this.closing) {
      const driver = this.driver;
      this.driverClosing = true;
      this.closing = Promise.resolve()
        .then(async () => {
          await driver?.disconnect();
        })
        .finally(() => {
          if (this.driver === driver) this.driver = undefined;
          this.driverClosing = false;
        });
    }
    return this.closing;
  }
  private fail(error: unknown): void {
    if (this.fault || this.control?.signal.aborted) return;
    this.fault = safeError(error);
    this.connected = false;
    this.control?.abort(this.fault);
    this.auth?.close(this.fault);
    const closing = this.closeDriver();
    this.state({ state: "error", error: this.fault });
    void closing.catch(() => {});
  }
  private receive = (message: Message): void =>
    this.enqueue(this.messages, message);
  private receiveReceipt = (receipt: MessageReceipt): void =>
    this.enqueue(this.receipts, receipt);
  private enqueue<T>(
    handlers: Set<(value: T) => void | Promise<void>>,
    value: T,
  ): void {
    const control = this.control;
    const queue = this.queue;
    if (
      !control ||
      control.signal.aborted ||
      this.closingRequested ||
      !handlers.size
    )
      return;
    if (queue.queued >= 100) {
      this.fail(
        new AdapterError(
          "QUEUE_OVERFLOW",
          "Переполнена очередь входящих сообщений.",
        ),
      );
      return;
    }
    queue.queued++;
    queue.delivery = queue.delivery
      .then(async () => {
        if (control.signal.aborted || control !== this.control) return;
        for (const handler of handlers) await handler(value);
      })
      .catch(() => {
        if (control === this.control)
          this.fail(
            new AdapterError(
              "HANDLER_ERROR",
              "Не удалось обработать входящее сообщение.",
            ),
          );
      })
      .finally(() => {
        queue.queued--;
      });
  }

  connect(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.start(undefined, options.signal);
  }
  authorize(options: {
    onEvent(event: AuthEvent): void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<void> {
    if (typeof options?.onEvent !== "function")
      return Promise.reject(
        new AdapterError(
          "INVALID_OPTIONS",
          "Нужен обработчик событий авторизации.",
        ),
      );
    return this.start(options.onEvent, options.signal);
  }
  private start(
    onEvent: ((event: AuthEvent) => void | Promise<void>) | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.busy || this.connected || this.driverClosing || this.disconnecting)
      return Promise.reject(
        new AdapterError(
          "INVALID_STATE",
          "Подключение или авторизация уже выполняется.",
        ),
      );
    if (signal?.aborted) return Promise.reject(cancelled());
    this.busy = true;
    this.closingRequested = false;
    this.queue = { delivery: Promise.resolve(), queued: 0 };
    this.fault = undefined;
    this.closing = undefined;
    const control = new AbortController();
    this.control = control;
    const abort = () => control.abort(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        control.abort(
          new AdapterError(
            onEvent ? "AUTH_TIMEOUT" : "PROVIDER_ERROR",
            onEvent
              ? "Истекло время авторизации."
              : "Истекло время подключения.",
          ),
        ),
      onEvent ? 180_000 : 90_000,
    );
    this.storage = new SerializedStorage(this.options.storage, (error) => {
      if (this.control === control) this.fail(error);
    });
    const auth = onEvent ? new AuthFlow(onEvent, control.signal) : undefined;
    this.auth = auth;
    const context: DriverContext = {
      onReceipt: (receipt) => {
        if (this.control === control) this.receiveReceipt(receipt);
      },
      storage: this.storage,
      signal: control.signal,
      auth,
      onMessage: (message) => {
        if (this.control === control) this.receive(message);
      },
      onError: (error) => {
        if (this.control === control) this.fail(error);
      },
    };
    const operation = Promise.resolve()
      .then(async () => {
        this.state({ state: onEvent ? "authorizing" : "connecting" });
        this.driver = await this.factory();
        if (control.signal.aborted) {
          await this.driver.disconnect();
          this.driver = undefined;
          throw control.signal.reason;
        }
        await abortable(
          onEvent
            ? this.driver.authorize(context)
            : this.driver.connect(context),
          control.signal,
        );
        await auth?.flush();
        await this.storage!.flush();
        if (control.signal.aborted) throw control.signal.reason;
        this.connected = true;
        this.state({ state: "connected" });
        if (control.signal.aborted) throw control.signal.reason;
      })
      .catch(async (error) => {
        const failure =
          this.fault ??
          (control.signal.aborted
            ? control.signal.reason instanceof AdapterError
              ? control.signal.reason
              : cancelled()
            : safeError(error));
        this.connected = false;
        control.abort(failure);
        auth?.close(failure);
        await this.closeDriver().catch(() => {});
        if (!this.fault)
          this.state(
            failure.code === "AUTH_CANCELLED"
              ? { state: "disconnected" }
              : { state: "error", error: failure },
          );
        throw failure;
      })
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        auth?.close();
        this.busy = false;
        this.auth = undefined;
        this.operation = undefined;
      });
    this.operation = operation;
    return operation;
  }
  respondToChallenge(response: { challengeId: string; value: string }): void {
    if (!this.auth)
      throw new AdapterError(
        "INVALID_CHALLENGE",
        "Нет ожидающего запроса подтверждения.",
      );
    this.auth.respond(response);
  }
  private async perform<T>(
    action: (driver: ProviderDriver) => Promise<T>,
  ): Promise<T> {
    if (this.fault) throw this.fault;
    if (!this.connected || !this.driver || !this.control)
      throw new AdapterError(
        "AUTH_REQUIRED",
        "Сначала восстановите сессию или выполните авторизацию.",
      );
    try {
      return await abortable(action(this.driver), this.control.signal);
    } catch (error) {
      if (
        error instanceof AdapterError &&
        ["INVALID_OPTIONS", "UNSUPPORTED_OPERATION"].includes(error.code)
      )
        throw error;
      this.fail(error);
      throw this.fault ?? safeError(error);
    }
  }
  listChats() {
    return this.perform((driver) => driver.listChats());
  }
  sendMedia(chatId: string, media: MediaInput) {
    try {
      if (typeof chatId !== "string" || !chatId.trim())
        throw new AdapterError("INVALID_OPTIONS", "Нужен ID диалога.");
      validateMedia(media);
    } catch (error) {
      return Promise.reject(error);
    }
    const copied = { ...media, data: new Uint8Array(media.data) };
    return this.perform((driver) => {
      if (!driver.sendMedia)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Провайдер не поддерживает отправку медиа.",
        );
      return driver.sendMedia(chatId, copied);
    });
  }
  downloadMedia(reference: string) {
    try {
      decodeMediaReference(reference, this.provider, this.accountId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.perform((driver) => {
      if (!driver.downloadMedia)
        throw new AdapterError(
          "UNSUPPORTED_OPERATION",
          "Провайдер не поддерживает скачивание медиа.",
        );
      return driver.downloadMedia(reference);
    });
  }
  getAvatar(target: AvatarTarget) {
    if (
      !target ||
      !["chat", "user"].includes(target.type) ||
      typeof target.id !== "string" ||
      !target.id.trim()
    )
      return Promise.reject(
        new AdapterError("INVALID_OPTIONS", "Нужны тип и ID аватарки."),
      );
    return this.perform(
      (driver) => driver.getAvatar?.(target) ?? Promise.resolve(undefined),
    );
  }
  listMessages(chatId: string, options: { limit?: number } = {}) {
    const limit = options.limit ?? 100;
    if (
      !chatId?.trim() ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return Promise.reject(
        new AdapterError(
          "INVALID_OPTIONS",
          "Нужны ID чата и лимит от 1 до 100.",
        ),
      );
    return this.perform(
      (driver) =>
        driver.listMessages?.(chatId, { limit }) ?? Promise.resolve([]),
    );
  }
  sendMessage(chatId: string, text: string) {
    if (
      typeof chatId !== "string" ||
      !chatId ||
      typeof text !== "string" ||
      !text.trim()
    )
      return Promise.reject(
        new AdapterError(
          "INVALID_OPTIONS",
          "Нужны идентификатор диалога и текст сообщения.",
        ),
      );
    return this.perform((driver) => driver.sendMessage(chatId, text));
  }
  onMessage(handler: (message: Message) => void | Promise<void>): () => void {
    this.messages.add(handler);
    return () => {
      this.messages.delete(handler);
    };
  }
  onReceipt(
    handler: (receipt: MessageReceipt) => void | Promise<void>,
  ): () => void {
    this.receipts.add(handler);
    return () => {
      this.receipts.delete(handler);
    };
  }
  onState(handler: (state: AdapterState) => void): () => void {
    this.states.add(handler);
    return () => {
      this.states.delete(handler);
    };
  }
  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const control = this.control;
    const auth = this.auth;
    const active = this.operation;
    const storage = this.storage;
    this.connected = false;
    this.closingRequested = true;
    if (this.busy) control?.abort(cancelled());
    auth?.close();
    const closing = this.closeDriver();
    this.disconnecting = Promise.resolve().then(async () => {
      let closeError: unknown;
      try {
        await closing.catch((error) => {
          closeError = error;
        });
        control?.abort(cancelled());
        await active?.catch(() => {});
        await storage?.flush();
        if (closeError) throw safeError(closeError);
        this.state({ state: "disconnected" });
      } finally {
        this.disconnecting = undefined;
      }
    });
    return this.disconnecting;
  }
}
