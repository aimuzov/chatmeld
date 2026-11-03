import { createInterface } from "node:readline";
import { WhatsAppRuntime } from "./runtime.js";

// Ключи шифрования из libsignal не должны попадать в логи.
console.log =
  console.info =
  console.warn =
  console.debug =
  console.error =
    () => undefined;
const emit = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const runtime = new WhatsAppRuntime(emit);
const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
let shutdown: Promise<void> | undefined;
const close = () =>
  (shutdown ??= Promise.resolve().then(async () => {
    lines.close();
    process.stdin.destroy();
    await runtime.close();
    await pending;
  }));

lines.on("line", (line) => {
  pending = pending.then(async () => {
    const request = JSON.parse(line) as {
      id: number;
      method: string;
      params: Parameters<WhatsAppRuntime["command"]>[1];
    };
    try {
      emit({
        id: request.id,
        result: await runtime.command(request.method, request.params),
      });
    } catch (error) {
      emit({
        id: request.id,
        error: error instanceof Error ? error.message : "Ошибка WhatsApp",
      });
    }
  });
});
lines.once("close", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
