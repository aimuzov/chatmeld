import {
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  type proto,
} from "@whiskeysockets/baileys";
import type { Message } from "../../core/provider.js";

export function normalizeMessage(
  message: proto.IWebMessageInfo,
  accountId: string,
): Message | undefined {
  const key = message.key;
  if (!key) return;
  const chatId = jidNormalizedUser(key.remoteJid ?? undefined);
  if (key.fromMe || !key.id || !isChatId(chatId)) return;
  const content = normalizeMessageContent(message.message);
  const type = getContentType(content);
  if (
    !content ||
    !type ||
    [
      "protocolMessage",
      "reactionMessage",
      "senderKeyDistributionMessage",
    ].includes(type)
  )
    return;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    "";
  const media: Record<string, string> = {
    imageMessage: "photo",
    videoMessage: "video",
    audioMessage: content.audioMessage?.ptt ? "voice" : "audio",
    documentMessage: "document",
    stickerMessage: "sticker",
  };
  const attachment =
    media[type] ??
    (!["conversation", "extendedTextMessage"].includes(type)
      ? type
      : undefined);
  const timestamp = Number(message.messageTimestamp?.toString());
  if (!Number.isFinite(timestamp)) return;
  return {
    provider: "whatsapp",
    accountId,
    chatId,
    messageId: `${chatId}:${key.id}`,
    senderId: jidNormalizedUser(key.participant ?? key.remoteJid ?? undefined),
    displayName: message.pushName ?? undefined,
    direction: "incoming",
    text,
    sentAt: new Date(timestamp * 1000).toISOString(),
    attachments: attachment ? [{ kind: attachment }] : [],
  };
}

export function isChatId(id: string): boolean {
  return /^\d+(?:-\d+)?@(s\.whatsapp\.net|lid|g\.us)$/.test(id);
}
