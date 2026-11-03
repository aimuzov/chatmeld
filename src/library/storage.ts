import { AdapterError } from "./errors.js";
import type { SessionStorage, SessionChange } from "./types.js";

export class MemorySessionStorage implements SessionStorage {
  private values = new Map<string, Uint8Array>();
  async read(key: string): Promise<Uint8Array | undefined> {
    return this.values.get(key)?.slice();
  }
  async writeBatch(changes: readonly SessionChange[]): Promise<void> {
    const next = new Map(this.values);
    for (const change of changes) {
      if (change.type === "set") next.set(change.key, change.value.slice());
      else next.delete(change.key);
    }
    this.values = next;
  }
}

export class SerializedStorage implements SessionStorage {
  private pending: Promise<void> = Promise.resolve();
  private fault?: AdapterError;
  constructor(
    private target: SessionStorage,
    private onError?: (error: AdapterError) => void,
  ) {}
  private fail(): AdapterError {
    if (!this.fault) {
      this.fault = new AdapterError(
        "STORAGE_ERROR",
        "Не удалось прочитать или сохранить сессию.",
      );
      this.onError?.(this.fault);
    }
    return this.fault;
  }
  async read(key: string): Promise<Uint8Array | undefined> {
    await this.pending;
    if (this.fault) throw this.fault;
    try {
      return (await this.target.read(key))?.slice();
    } catch {
      throw this.fail();
    }
  }
  writeBatch(changes: readonly SessionChange[]): Promise<void> {
    const copied = changes.map((change) =>
      change.type === "set"
        ? { ...change, value: change.value.slice() }
        : { ...change },
    );
    const next = this.pending.then(async () => {
      if (this.fault) throw this.fault;
      try {
        await this.target.writeBatch(copied);
      } catch {
        throw this.fail();
      }
    });
    this.pending = next.catch(() => {});
    return next;
  }
  async flush(): Promise<void> {
    await this.pending;
    if (this.fault) throw this.fault;
  }
}

export async function readStored<T>(
  storage: SessionStorage,
  key: string,
): Promise<T | undefined> {
  const value = await storage.read(key);
  if (value === undefined) return;
  try {
    const envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    ) as { version: number; data: T };
    if (envelope.version !== 1 || !("data" in envelope)) throw Error();
    return envelope.data;
  } catch {
    throw new AdapterError(
      "STORAGE_ERROR",
      "Сохранённая сессия повреждена или имеет неподдерживаемую версию.",
    );
  }
}

export async function writeStored<T>(
  storage: SessionStorage,
  key: string,
  value: T,
): Promise<void> {
  await storage.writeBatch([
    {
      type: "set",
      key,
      value: new TextEncoder().encode(
        JSON.stringify({ version: 1, data: value }),
      ),
    },
  ]);
}
