import { parentPort } from "node:worker_threads";
import { WhatsAppLibraryRuntime } from "./library-runtime.js";
import type {
  MediaInput,
  AvatarTarget,
  SessionChange,
} from "../../library/types.js";
import { AdapterError, safeError } from "../../library/errors.js";

const port = parentPort!;
let sequence = 0;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
const requestStorage = (method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (pending.size >= 256) {
      reject(new Error("Переполнена очередь хранилища WhatsApp."));
      return;
    }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    port.postMessage({ storage: true, id, method, params });
  });
let runtime: WhatsAppLibraryRuntime | undefined;
const stopping = new AbortController();
port.on(
  "message",
  (request: {
    storage?: boolean;
    id: number;
    method: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }) => {
    if (request.storage) {
      const waiter = pending.get(request.id);
      pending.delete(request.id);
      if (request.error)
        waiter?.reject(
          new AdapterError(
            "STORAGE_ERROR",
            "Ошибка хранилища сессии WhatsApp.",
          ),
        );
      else waiter?.resolve(request.result);
      return;
    }
    void (async () => {
      try {
        let result: unknown;
        if (request.method === "connect" || request.method === "authorize") {
          runtime = new WhatsAppLibraryRuntime(
            request.params!.accountId as string,
          );
          await runtime.open(
            {
              signal: stopping.signal,
              storage: {
                read: async (key) =>
                  (await requestStorage("read", { key })) as
                    Uint8Array | undefined,
                writeBatch: async (changes: readonly SessionChange[]) => {
                  await requestStorage("writeBatch", { changes });
                },
              },
              auth:
                request.method === "authorize"
                  ? {
                      qr: async (value) => {
                        port.postMessage({ event: "qr", value });
                      },
                      challenge: async () => {
                        throw new Error(
                          "WhatsApp не поддерживает этот запрос.",
                        );
                      },
                      progress: (message) =>
                        port.postMessage({ event: "progress", message }),
                    }
                  : undefined,
              onReceipt: (receipt) =>
                port.postMessage({ event: "receipt", receipt }),
              onMessage: (message) =>
                port.postMessage({ event: "message", message }),
              onError: (error) =>
                port.postMessage({
                  event: "error",
                  code: safeError(error).code,
                  error: safeError(error).message,
                }),
            },
            request.method === "authorize",
          );
        } else if (request.method === "chats") result = runtime!.listChats();
        else if (request.method === "historyPage")
          result = await runtime!.listHistoryPage(
            request.params!.chatId as string,
            {
              limit: request.params!.limit as number,
              cursor: request.params!.cursor as string | undefined,
            },
          );
        else if (request.method === "avatar")
          result = await runtime!.avatarUrl(
            request.params as unknown as AvatarTarget,
          );
        else if (request.method === "sendMedia")
          result = await runtime!.sendMedia(
            request.params!.chatId as string,
            request.params!.media as MediaInput,
          );
        else if (request.method === "downloadMedia")
          result = await runtime!.downloadMedia(
            request.params!.reference as string,
          );
        else if (request.method === "send")
          result = await runtime!.sendMessage(
            request.params!.chatId as string,
            request.params!.text as string,
          );
        else if (request.method === "close") {
          stopping.abort();
          await runtime?.close();
        } else throw new Error("Неизвестная операция WhatsApp.");
        port.postMessage({ id: request.id, result });
      } catch (error) {
        const safe = safeError(error);
        port.postMessage({
          id: request.id,
          code: safe.code,
          error: safe.message,
        });
      }
    })();
  },
);
