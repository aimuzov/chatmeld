import { Api, utils } from "teleproto";
import type { Message } from "../../core/provider.js";

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
    attachments: message.media ? [{ kind: message.media.className }] : [],
  };
}
