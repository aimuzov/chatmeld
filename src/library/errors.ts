export type AdapterErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_STATE"
  | "AUTH_REQUIRED"
  | "AUTH_CANCELLED"
  | "AUTH_TIMEOUT"
  | "INVALID_CHALLENGE"
  | "INVALID_RESPONSE"
  | "STORAGE_ERROR"
  | "PROVIDER_ERROR"
  | "HANDLER_ERROR"
  | "QUEUE_OVERFLOW"
  | "DISCONNECTED";

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function safeError(error: unknown): AdapterError {
  return error instanceof AdapterError
    ? error
    : new AdapterError(
        "PROVIDER_ERROR",
        "Не удалось выполнить операцию мессенджера.",
      );
}

export function cancelled(): AdapterError {
  return new AdapterError("AUTH_CANCELLED", "Операция отменена.");
}

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof AdapterError ? signal.reason : cancelled(),
      );
    const cleanup = () => signal.removeEventListener("abort", abort);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
