import type { Chat, Message, ProviderKind } from "../core/provider.js";

export type { Chat, Message, ProviderKind };

export type SessionChange =
  | { type: "set"; key: string; value: Uint8Array }
  | { type: "delete"; key: string };

export interface SessionStorage {
  read(key: string): Promise<Uint8Array | undefined>;
  writeBatch(changes: readonly SessionChange[]): Promise<void>;
}

export type AuthEvent =
  | { type: "qr"; value: string; expiresAt?: string }
  | {
      type: "challenge";
      challengeId: string;
      kind: "code" | "password";
      prompt: string;
      pattern?: string;
    }
  | { type: "progress"; message: string };

export interface AuthChannel {
  qr(value: string, expiresAt?: string): Promise<void>;
  challenge(options: {
    kind: "code" | "password";
    prompt: string;
    pattern?: string;
  }): Promise<string>;
  progress(message: string): void;
}

export interface DriverContext {
  storage: SessionStorage;
  signal: AbortSignal;
  auth?: AuthChannel;
  onMessage(message: Message): void;
  onError(error: Error): void;
}

export interface ProviderDriver {
  connect(context: DriverContext): Promise<void>;
  authorize(context: DriverContext): Promise<void>;
  listChats(): Promise<Chat[]>;
  listMessages?(
    chatId: string,
    options?: { limit?: number },
  ): Promise<Message[]>;
  sendMessage(chatId: string, text: string): Promise<{ externalId: string }>;
  disconnect(): Promise<void>;
}

export type AdapterOptions = {
  accountId: string;
  storage: SessionStorage;
} & (
  | { provider: "telegram"; apiId: number; apiHash: string }
  | { provider: "max"; pythonCommand?: string }
  | { provider: "whatsapp" }
  | { provider: "vk" }
);

export type AdapterState =
  | {
      state:
        "idle" | "connecting" | "authorizing" | "connected" | "disconnected";
    }
  | { state: "error"; error: Error };

export interface MessagingAdapter {
  readonly provider: ProviderKind;
  readonly accountId: string;
  connect(options?: { signal?: AbortSignal }): Promise<void>;
  authorize(options: {
    onEvent(event: AuthEvent): void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<void>;
  respondToChallenge(response: { challengeId: string; value: string }): void;
  listChats(): Promise<Chat[]>;
  listMessages?(
    chatId: string,
    options?: { limit?: number },
  ): Promise<Message[]>;
  sendMessage(chatId: string, text: string): Promise<{ externalId: string }>;
  onMessage(handler: (message: Message) => void | Promise<void>): () => void;
  onState(handler: (state: AdapterState) => void): () => void;
  disconnect(): Promise<void>;
}
