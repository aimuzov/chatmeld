import { Adapter } from "./library/adapter.js";
import type {
  AdapterOptions,
  MessagingAdapter,
  ProviderDriver,
} from "./library/types.js";
export type {
  Avatar,
  AvatarTarget,
  MediaInput,
  MediaFile,
  MediaAttachment,
  AdapterOptions,
  AdapterState,
  AuthEvent,
  Chat,
  Message,
  MessagingAdapter,
  ProviderKind,
  SessionChange,
  SessionStorage,
} from "./library/types.js";
export { AdapterError } from "./library/errors.js";
export type { AdapterErrorCode } from "./library/errors.js";
export { MemorySessionStorage } from "./library/storage.js";

export function createAdapter(options: AdapterOptions): MessagingAdapter {
  const configuration = { ...options };
  return new Adapter(configuration, async (): Promise<ProviderDriver> => {
    switch (configuration.provider) {
      case "instagram":
        return (
          await import("./providers/instagram/library.js")
        ).createInstagramDriver(configuration);
      case "telegram":
        return (
          await import("./providers/telegram/library.js")
        ).createTelegramDriver(configuration);
      case "vk":
        return (await import("./providers/vk/library.js")).createVkDriver(
          configuration,
        );
      case "whatsapp":
        return (
          await import("./providers/whatsapp/library.js")
        ).createWhatsAppDriver(configuration);
      case "max":
        return (await import("./providers/max/library.js")).createMaxDriver(
          configuration,
        );
    }
  });
}
