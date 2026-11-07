import {
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
} from "@whiskeysockets/baileys";
import { encodeMediaReference } from "../../library/media.js";
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
    audioMessage: "audio",
    documentMessage: "document",
    stickerMessage: "sticker",
  };
  const attachment =
    media[type] ??
    (!["conversation", "extendedTextMessage"].includes(type)
      ? type
      : undefined);
  const rawMedia =
    content.imageMessage ??
    content.videoMessage ??
    content.audioMessage ??
    content.documentMessage;
  const mimeType = rawMedia?.mimetype ?? undefined;
  const fileName = content.documentMessage?.fileName ?? undefined;
  const rawSize = rawMedia?.fileLength;
  const size = rawSize == null ? undefined : Number(rawSize.toString());
  const reference = rawMedia
    ? encodeMediaReference("whatsapp", accountId, {
        message: Buffer.from(
          proto.WebMessageInfo.encode(message).finish(),
        ).toString("base64"),
      })
    : undefined;
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
    attachments: attachment
      ? [
          {
            kind: attachment,
            ...(reference ? { reference } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(fileName ? { fileName } : {}),
            ...(Number.isSafeInteger(size) ? { size } : {}),
          },
        ]
      : [],
  };
}

export function isChatId(id: string): boolean {
  return /^\d+(?:-\d+)?@(s\.whatsapp\.net|lid|g\.us|bot)$/.test(id);
}
