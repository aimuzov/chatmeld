import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { SessionChange, SessionStorage } from "../../library/types.js";
import { AdapterError } from "../../library/errors.js";

const credentialsKey = "whatsapp.v1.credentials";
const encode = (data: unknown) =>
  Buffer.from(JSON.stringify({ version: 1, data }, BufferJSON.replacer));
const decode = (bytes: Uint8Array): unknown => {
  const value = JSON.parse(
    Buffer.from(bytes).toString("utf8"),
    BufferJSON.reviver,
  ) as { version?: number; data?: unknown };
  if (value.version !== 1 || !value.data) throw new Error("Invalid session");
  return value.data;
};
const keyName = (type: string, id: string) =>
  `whatsapp.v1.key.${encodeURIComponent(type)}.${encodeURIComponent(id)}`;
const storageError = () =>
  new AdapterError("STORAGE_ERROR", "Ошибка хранилища сессии WhatsApp.");

export async function createWhatsAppAuthState(
  storage: SessionStorage,
  onFailure: (error: Error) => void = () => {},
) {
  let pending = Promise.resolve();
  let fault: Error | undefined;
  const fail = () => {
    if (!fault) {
      fault = storageError();
      onFailure(fault);
    }
    return fault;
  };
  const read = async (key: string) => {
    if (fault) throw fault;
    try {
      const bytes = await storage.read(key);
      return bytes === undefined ? undefined : decode(bytes);
    } catch {
      throw fail();
    }
  };
  const saved = (await read(credentialsKey)) as AuthenticationCreds | undefined;
  if (
    saved &&
    (!saved.noiseKey?.private ||
      !saved.signedIdentityKey?.private ||
      !saved.signedPreKey?.keyPair?.private ||
      typeof saved.registrationId !== "number")
  )
    throw fail();
  const creds = saved ?? initAuthCreds();
  const write = (changes: readonly SessionChange[]) => {
    const task = pending.then(async () => {
      if (fault) throw fault;
      try {
        await storage.writeBatch(changes);
      } catch {
        throw fail();
      }
    });
    pending = task;
    void task.catch(() => {});
    return task;
  };
  const state: AuthenticationState = {
    creds,
    keys: {
      async get(type, ids) {
        await pending;
        const values: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const id of ids) {
          let value = await read(keyName(type, id));
          if (type === "app-state-sync-key" && value)
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          if (value !== undefined)
            values[id] = value as SignalDataTypeMap[typeof type];
        }
        return values;
      },
      set(data) {
        const changes: SessionChange[] = [];
        for (const [type, entries] of Object.entries(data))
          for (const [id, value] of Object.entries(entries ?? {}))
            changes.push(
              value === null
                ? { type: "delete", key: keyName(type, id) }
                : { type: "set", key: keyName(type, id), value: encode(value) },
            );
        return write(changes);
      },
    },
  };
  return {
    state,
    restored: saved !== undefined,
    saveCreds: () =>
      write([{ type: "set", key: credentialsKey, value: encode(creds) }]),
    flush: () => pending,
  };
}
