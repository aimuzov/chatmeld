import { Api, utils } from "teleproto";
import { encodeMediaReference } from "../../library/media.js";
import type { MediaAttachment, Message } from "../../core/provider.js";

export function normalizeMessage(
  message: Api.Message,
  accountId: string,
): Message {
  const chatId = utils.getPeerId(message.peerId);
  return {
    provider: "telegram",
    accountId,
    chatId,
    messageId: `${chatId}:${message.id}`,
    senderId: message.fromId ? utils.getPeerId(message.fromId) : undefined,
    direction: message.out ? "outgoing" : "incoming",
    text: message.message,
    sentAt: new Date(message.date * 1000).toISOString(),
    attachments: telegramAttachments(message, accountId),
  };
}

export function telegramAttachments(
  message: Api.Message,
  accountId: string,
): MediaAttachment[] {
  const media = message.media;
  if (!media) return [];
  const reference = encodeMediaReference("telegram", accountId, {
    chatId: utils.getPeerId(message.peerId),
    messageId: String(message.id),
  });
  if (
    media instanceof Api.MessageMediaPhoto &&
    media.photo instanceof Api.Photo
  )
    return [{ kind: "photo", mimeType: "image/jpeg", reference }];
  if (
    media instanceof Api.MessageMediaDocument &&
    media.document instanceof Api.Document
  ) {
    const doc = media.document;
    const kind = doc.mimeType.startsWith("video/")
      ? "video"
      : doc.mimeType.startsWith("audio/")
        ? "audio"
        : doc.mimeType.startsWith("image/")
          ? "photo"
          : "document";
    const fileName = doc.attributes.find(
      (attribute) => attribute instanceof Api.DocumentAttributeFilename,
    )?.fileName;
    const size = Number(doc.size.toString());
    return [
      {
        kind,
        mimeType: doc.mimeType,
        reference,
        ...(fileName ? { fileName } : {}),
        ...(Number.isSafeInteger(size) ? { size } : {}),
      },
    ];
  }
  return [{ kind: media.className }];
}
