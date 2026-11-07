export type ProviderKind = "telegram" | "max" | "whatsapp" | "vk" | "instagram";

export interface Chat {
  id: string;
  title: string;
}

export interface MediaAttachment {
  kind: string;
  reference?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
}

export interface MediaFile {
  data: Uint8Array;
  mimeType: string;
  fileName?: string;
}

export interface MediaInput extends MediaFile {
  kind: "photo" | "video" | "audio";
  caption?: string;
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
  status?: "sent" | "delivered" | "read";
  attachments: MediaAttachment[];
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
