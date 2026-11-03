import {
  jidNormalizedUser,
  type Contact,
  type proto,
} from "@whiskeysockets/baileys";
import type { Chat } from "../../core/provider.js";
import { isChatId } from "./normalize.js";

export class WhatsAppCatalog {
  private people = new Map<string, Partial<Contact>>();
  private conversations = new Map<string, string>();

  observe(message: proto.IWebMessageInfo): void {
    this.chats([{ id: message.key?.remoteJid }]);
    if (!message.key?.fromMe && message.pushName) {
      this.contacts([
        {
          id: message.key?.participant || message.key?.remoteJid || "",
          notify: message.pushName,
        },
      ]);
    }
  }

  contacts(items: Partial<Contact>[]): void {
    for (const item of items) {
      if (!item.id) continue;
      const keys = [item.id, item.lid, item.phoneNumber]
        .filter((key): key is string => !!key)
        .map(jidNormalizedUser);
      const previous = new Set(
        keys.map((key) => this.people.get(key)).filter((value) => !!value),
      );
      const contact = {
        ...Object.assign(
          {},
          ...[...previous].map((value) =>
            Object.fromEntries(
              Object.entries(value).filter(
                ([, entry]) => entry !== undefined && entry !== "",
              ),
            ),
          ),
        ),
        ...Object.fromEntries(
          Object.entries(item).filter(([, value]) => value !== undefined),
        ),
      };
      for (const key of keys) this.people.set(key, contact);
      for (const [key, value] of this.people)
        if (previous.has(value)) this.people.set(key, contact);
    }
  }

  chats(items: { id?: string | null; name?: string | null }[]): void {
    for (const item of items) {
      const id = jidNormalizedUser(item.id ?? undefined);
      if (isChatId(id))
        this.conversations.set(
          id,
          item.name?.trim() || this.conversations.get(id) || "",
        );
    }
  }

  remove(ids: string[]): void {
    for (const id of ids) this.conversations.delete(jidNormalizedUser(id));
  }

  list(): Chat[] {
    return [...this.conversations]
      .map(([id, title]) => {
        const person = this.people.get(id);
        const name = person?.name || person?.notify || person?.verifiedName;
        return {
          id,
          title: (id.endsWith("@g.us") ? title : name || title) || id,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "ru"));
  }

  hasNamedPeople(): boolean {
    return this.list().some(
      (chat) => !chat.id.endsWith("@g.us") && chat.title !== chat.id,
    );
  }

  mappings(items: { lid: string; pn: string }[]): void {
    this.contacts(
      items.map((item) => ({
        id: item.lid,
        lid: item.lid,
        phoneNumber: item.pn,
      })),
    );
  }

  snapshot(): { chats: Chat[]; contacts: Partial<Contact>[] } {
    return {
      chats: [...this.conversations].map(([id, title]) => ({ id, title })),
      contacts: [...this.people].map(([id, contact]) => ({ ...contact, id })),
    };
  }

  restore(value: { chats: Chat[]; contacts: Partial<Contact>[] }): void {
    this.chats(value.chats.map((chat) => ({ id: chat.id, name: chat.title })));
    this.contacts(value.contacts);
  }
}
