import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class JsonProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private fault?: Error;
  private closing = false;
  private exited: Promise<void>;

  constructor(
    command: string,
    args: string[],
    private onEvent: (event: Record<string, unknown>) => void,
    private onError: (error: Error) => void,
    private label = "MAX",
  ) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.pipe(process.stderr);
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) =>
      this.child.once("close", (code) => {
        if (!this.closing)
          this.fail(
            new Error(`${this.label}-процесс завершился (код ${code}).`),
          );
        resolve();
      }),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (typeof response.id === "number") {
          const request = this.pending.get(response.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(response.id);
          if (typeof response.error === "string")
            request.reject(new Error(response.error));
          else request.resolve(response.result);
        } else this.onEvent(response);
      } catch {
        this.fail(new Error(`Некорректный ответ ${this.label}-процесса.`));
        this.child.kill();
      }
    });
    this.child.once("close", () => lines.close());
  }

  request<T>(
    method: string,
    params: unknown = {},
    timeout = 45_000,
  ): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    if (this.closing)
      return Promise.reject(new Error(`${this.label}-процесс закрыт.`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(`${this.label}: истекло время ожидания ${method}.`),
        );
        this.child.kill();
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.notify({ id, method, params });
    });
  }

  notify(value: unknown): void {
    if (!this.fault && !this.closing)
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  abort(error: Error): void {
    this.fail(error);
    this.child.kill();
  }

  private fail(error: Error): void {
    if (this.fault) return;
    this.fault = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.onError(error);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.fail(new Error(`${this.label}-процесс закрыт.`));
    this.child.stdin.end();
    const timeout = new AbortController();
    try {
      await Promise.race([
        this.exited,
        delay(2000, undefined, { signal: timeout.signal }),
      ]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await this.exited;
      }
    } finally {
      timeout.abort();
    }
  }
}
