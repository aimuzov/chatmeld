import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { downloadAvatar } from "../../library/avatar.js";
import { AdapterError, type AdapterErrorCode } from "../../library/errors.js";
import type {
  MediaFile,
  Chat,
  DriverContext,
  Message,
  ProviderDriver,
  SessionChange,
} from "../../library/types.js";

type Reply = {
  id?: number;
  storage?: boolean;
  method?: string;
  params?: { key: string; changes: SessionChange[] };
  result?: unknown;
  error?: string;
  code?: AdapterErrorCode;
  event?: string;
  value?: string;
  message?: Message | string;
};

export function createWhatsAppDriver(options: {
  accountId: string;
}): ProviderDriver {
  let worker: Worker | undefined;
  let context: DriverContext | undefined;
  let sequence = 0;
  let fault: Error | undefined;
  let closing = false;
  let storageQueue = Promise.resolve();
  let authQueue = Promise.resolve();
  let abort: (() => void) | undefined;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (error: Error) => {
    if (fault || closing) return;
    fault = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    context?.onError(error);
    void worker?.terminate();
  };
  const request = <T>(method: string, params: unknown = {}): Promise<T> => {
    if (fault) return Promise.reject(fault);
    if (!worker) return Promise.reject(new Error("WhatsApp не подключён."));
    if (pending.size >= 100) {
      const error = new Error("Переполнена очередь операций WhatsApp.");
      fail(error);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => fail(new Error("Истекло время операции WhatsApp.")),
        method === "authorize" ? 125_000 : 45_000,
      );
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      worker!.postMessage({ id, method, params });
    });
  };
  const open = async (nextContext: DriverContext, authorize: boolean) => {
    if (worker) throw new Error("WhatsApp уже подключается или подключён.");
    if (nextContext.signal.aborted)
      throw new Error("Подключение WhatsApp отменено.");
    context = nextContext;
    fault = undefined;
    closing = false;
    storageQueue = Promise.resolve();
    authQueue = Promise.resolve();
    const source = import.meta.url.endsWith(".ts");
    worker = source
      ? new Worker(
          new URL(
            `data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}; register(); await import(${JSON.stringify(new URL("./library-worker.ts", import.meta.url).href)});`)}`,
          ),
          { stdout: true, stderr: true },
        )
      : new Worker(new URL("./library-worker.js", import.meta.url), {
          stdout: true,
          stderr: true,
        });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on("error", () =>
      fail(new Error("Ошибка рабочего процесса WhatsApp.")),
    );
    worker.on("exit", () => {
      if (!closing && !fault)
        fail(new Error("Рабочий процесс WhatsApp завершился."));
    });
    worker.on("message", (reply: Reply) => {
      if (reply.storage) {
        const active = worker;
        storageQueue = storageQueue.then(async () => {
          try {
            const result =
              reply.method === "read"
                ? await context!.storage.read(reply.params!.key)
                : await context!.storage.writeBatch(reply.params!.changes);
            active?.postMessage({ storage: true, id: reply.id, result });
          } catch {
            active?.postMessage({
              storage: true,
              id: reply.id,
              error: "storage",
            });
            fail(
              new AdapterError(
                "STORAGE_ERROR",
                "Ошибка хранилища сессии WhatsApp.",
              ),
            );
          }
        });
        return;
      }
      if (reply.id !== undefined) {
        const entry = pending.get(reply.id);
        if (!entry) return;
        pending.delete(reply.id);
        clearTimeout(entry.timer);
        if (reply.error)
          entry.reject(
            new AdapterError(reply.code ?? "PROVIDER_ERROR", reply.error),
          );
        else entry.resolve(reply.result);
      } else if (reply.event === "error")
        fail(
          new AdapterError(
            reply.code ?? "PROVIDER_ERROR",
            reply.error ?? "Ошибка подключения WhatsApp.",
          ),
        );
      else if (reply.event === "message" && !fault && !closing)
        context!.onMessage(reply.message as Message);
      else if (reply.event === "qr" && context!.auth) {
        authQueue = authQueue.then(() => context!.auth!.qr(reply.value!));
        void authQueue.catch(() =>
          fail(new Error("Ошибка обработки авторизации WhatsApp.")),
        );
      } else if (reply.event === "progress")
        context!.auth?.progress(reply.message as string);
    });
    abort = () => fail(new Error("Подключение WhatsApp отменено."));
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      await request(authorize ? "authorize" : "connect", options);
      await authQueue;
    } catch (error) {
      await driver.disconnect().catch(() => {});
      throw error;
    }
  };
  const driver: ProviderDriver = {
    connect: (context) => open(context, false),
    authorize: (context) => open(context, true),
    listChats: () => request<Chat[]>("chats"),
    getAvatar: async (target) =>
      downloadAvatar(
        await request<string | undefined>("avatar", target),
        ["whatsapp.net", "whatsapp.com", "fbcdn.net"],
        context?.signal,
      ),
    sendMedia: (chatId, media) =>
      request<{ externalId: string }>("sendMedia", { chatId, media }),
    downloadMedia: (reference) =>
      request<MediaFile>("downloadMedia", { reference }),
    sendMessage: (chatId, text) =>
      request<{ externalId: string }>("send", { chatId, text }),
    async disconnect() {
      const active = worker;
      if (!active) return;
      if (context && abort) context.signal.removeEventListener("abort", abort);
      if (!fault) {
        try {
          await request("close");
        } catch {}
      }
      closing = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("WhatsApp отключён."));
      }
      pending.clear();
      await storageQueue;
      await active.terminate();
      worker = undefined;
    },
  };
  return driver;
}
