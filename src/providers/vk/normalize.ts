import type { MessageContext } from "vk-io";
import type { Chat, Message } from "../../core/provider.js";

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
    attachments: context.attachments.map((attachment) => ({
      kind: attachment.type,
    })),
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
