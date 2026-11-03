export type ProviderKind = "telegram" | "max" | "whatsapp" | "vk";

export interface Chat {
  id: string;
  title: string;
}

export interface Message {
  provider: ProviderKind;
  accountId: string;
  chatId: string;
  messageId: string;
  senderId?: string;
  displayName?: string;
  username?: string;
  direction: "incoming" | "outgoing";
  text: string;
  sentAt: string;
  attachments: { kind: string }[];
}

export interface MessagingProvider {
  readonly kind: ProviderKind;
  readonly accountId: string;
  connect(): Promise<void>;
  login(options?: { method?: "phone" | "qr" }): Promise<void>;
  requireAuthorization(): Promise<void>;
  disconnect(): Promise<void>;
  listChats(): Promise<Chat[]>;
  sendMessage(chatId: string, text: string): Promise<{ externalId: string }>;
  subscribe(handler: (message: Message) => void): () => void;
  onError?(handler: (error: Error) => void): () => void;
}
