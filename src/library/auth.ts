import { randomUUID } from "node:crypto";
import { AdapterError, abortable, cancelled } from "./errors.js";
import type { AuthChannel, AuthEvent } from "./types.js";

export class AuthFlow implements AuthChannel {
  private pending = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      pattern?: RegExp;
    }
  >();
  private completed = false;
  private eventWrites = Promise.resolve();
  private eventError?: unknown;
  private eventFailed = false;
  constructor(
    private onEvent: (event: AuthEvent) => void | Promise<void>,
    private signal: AbortSignal,
  ) {
    signal.addEventListener("abort", this.abort, { once: true });
  }
  private abort = () =>
    this.close(
      this.signal.reason instanceof AdapterError
        ? this.signal.reason
        : cancelled(),
    );
  private emit(event: AuthEvent): Promise<void> {
    const next = this.eventWrites.then(async () => {
      if (this.completed || this.signal.aborted) throw cancelled();
      if (this.eventFailed) throw this.eventError;
      await abortable(Promise.resolve(this.onEvent(event)), this.signal);
    });
    this.eventWrites = next.catch((error) => {
      this.eventError = error;
      this.eventFailed = true;
      this.close(
        new AdapterError(
          "HANDLER_ERROR",
          "Не удалось передать событие авторизации.",
        ),
      );
    });
    return next;
  }
  qr(value: string, expiresAt?: string): Promise<void> {
    return this.emit({
      type: "qr",
      value,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  progress(message: string): void {
    void this.emit({ type: "progress", message }).catch(() => {});
  }
  async challenge(
    options: Parameters<AuthChannel["challenge"]>[0],
  ): Promise<string> {
    if (this.completed || this.signal.aborted) throw cancelled();
    const challengeId = randomUUID();
    const waiting = new Promise<string>((resolve, reject) => {
      this.pending.set(challengeId, {
        resolve,
        reject,
        pattern: options.pattern ? new RegExp(options.pattern) : undefined,
      });
    });
    const result = abortable(waiting, this.signal);
    void result.catch(() => {});
    try {
      await this.emit({ type: "challenge", challengeId, ...options });
      return await result;
    } finally {
      this.pending.delete(challengeId);
    }
  }
  respond({
    challengeId,
    value,
  }: {
    challengeId: string;
    value: string;
  }): void {
    const request = this.pending.get(challengeId);
    if (!request || this.completed || this.signal.aborted)
      throw new AdapterError(
        "INVALID_CHALLENGE",
        "Запрос подтверждения не существует или уже завершён.",
      );
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4096 ||
      (request.pattern && !request.pattern.test(value))
    )
      throw new AdapterError(
        "INVALID_RESPONSE",
        "Ответ не соответствует запросу подтверждения.",
      );
    this.pending.delete(challengeId);
    request.resolve(value);
  }
  async flush(): Promise<void> {
    await this.eventWrites;
    if (this.eventFailed)
      throw new AdapterError(
        "HANDLER_ERROR",
        "Не удалось передать событие авторизации.",
      );
  }
  close(error: Error = cancelled()): void {
    this.completed = true;
    this.signal.removeEventListener("abort", this.abort);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
