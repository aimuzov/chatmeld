import type { MessageContext } from "vk-io";
import { encodeMediaReference } from "../../library/media.js";
import type { MediaAttachment, Chat, Message } from "../../core/provider.js";

export function normalizeMessage(
  context: MessageContext,
  accountId: string,
): Message | undefined {
  if (context.isOutbox || context.isEvent) return;
  const id = context.conversationMessageId ?? context.id;
  if (!id) return;
  return {
    provider: "vk",
    accountId,
    chatId: String(context.peerId),
    messageId: `${context.peerId}:${id}`,
    senderId: String(context.senderId),
    direction: "incoming",
    text: context.text ?? "",
    sentAt: new Date(context.createdAt * 1000).toISOString(),
    attachments: normalizeAttachments(
      context.attachments,
      String(context.peerId),
      context.conversationMessageId,
      accountId,
    ),
  };
}

export function conversationChats(page: {
  items: unknown[];
  profiles?: { id: number; first_name?: string; last_name?: string }[];
  groups?: { id: number; name?: string }[];
}): Chat[] {
  const names = new Map<number, string>();
  for (const user of page.profiles ?? [])
    names.set(
      user.id,
      [user.first_name, user.last_name].filter(Boolean).join(" "),
    );
  for (const group of page.groups ?? []) names.set(-group.id, group.name ?? "");
  return page.items.map((item) => {
    const { conversation } = item as {
      conversation?: {
        peer?: { id: number };
        chat_settings?: { title?: string };
      };
    };
    if (!conversation?.peer || !Number.isSafeInteger(conversation.peer.id))
      throw new Error("VK не вернул ID диалога.");
    return {
      id: String(conversation.peer.id),
      title:
        conversation.chat_settings?.title ||
        names.get(conversation.peer.id) ||
        String(conversation.peer.id),
    };
  });
}

type VkAttachment = {
  type: string;
  id?: number;
  ownerId?: number;
  doc?: { ext?: string; title?: string; size?: number };
  isAudio?: boolean;
  extension?: string;
  title?: string;
  size?: number;
};
export function vkDocumentMime(
  extension: string | undefined,
): string | undefined {
  const types: Record<string, string> = {
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    flac: "audio/flac",
    mp4: "video/mp4",
    webm: "video/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return extension ? types[extension.toLowerCase()] : undefined;
}
export function normalizeAttachments(
  attachments: readonly unknown[],
  chatId: string,
  conversationMessageId: number | undefined,
  accountId: string,
): MediaAttachment[] {
  return attachments.map((value, index) => {
    const attachment = value as VkAttachment;
    const mimeType =
      attachment.type === "doc"
        ? vkDocumentMime(attachment.doc?.ext ?? attachment.extension)
        : undefined;
    const kind =
      attachment.type === "audio_message"
        ? "audio"
        : attachment.type === "doc" && mimeType
          ? mimeType.startsWith("audio/")
            ? "audio"
            : mimeType.startsWith("video/")
              ? "video"
              : "photo"
          : attachment.type;
    const downloadable = ["photo", "video", "audio"].includes(kind);
    const fileName =
      attachment.type === "doc"
        ? (attachment.doc?.title ?? attachment.title)
        : undefined;
    const size = attachment.doc?.size ?? attachment.size;
    return {
      kind,
      ...(downloadable && conversationMessageId
        ? {
            reference: encodeMediaReference("vk", accountId, {
              chatId,
              conversationMessageId,
              index,
              ...(attachment.id !== undefined
                ? {
                    attachmentType: attachment.type,
                    attachmentId: attachment.id,
                    ownerId: attachment.ownerId,
                  }
                : {}),
            }),
          }
        : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(typeof size === "number" ? { size } : {}),
    };
  });
}
