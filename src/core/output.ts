import { once } from "node:events";
import type { Writable } from "node:stream";

export async function writeMessage(
  output: Writable,
  message: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (!output.write(`${JSON.stringify(message)}\n`)) {
    try {
      await once(output, "drain", { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
