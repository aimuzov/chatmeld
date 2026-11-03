import { parseArgs } from "node:util";
import { once } from "node:events";
import { ProviderRegistry } from "./core/registry.js";
import { deliverWebhook } from "./core/webhook.js";
import { writeMessage } from "./core/output.js";
import { TelegramProvider } from "./providers/telegram/provider.js";
import { MaxProvider } from "./providers/max/provider.js";
import { WhatsAppProvider } from "./providers/whatsapp/provider.js";
import { VkProvider } from "./providers/vk/provider.js";

const help = `chatmeld: клиенты личных аккаунтов

npm start -- login
npm start -- login --qr
npm start -- login --provider=max --qr
npm start -- login --provider=whatsapp --qr
npm start -- login --provider=vk
npm start -- login --provider=vk --qr
npm start -- chats
npm start -- listen [--chat=ID] [--webhook=http://localhost:3000/messages]
npm start -- send --chat=ID --text='Привет'

Опции: --provider=telegram --account=personal --help
Провайдеры: telegram, max, whatsapp, vk. listen выводит JSONL в stdout.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string", default: "telegram" },
      account: { type: "string", default: "personal" },
      chat: { type: "string" },
      text: { type: "string" },
      webhook: { type: "string" },
      help: { type: "boolean" },
      qr: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (
    positionals.length !== 1 ||
    !["login", "chats", "listen", "send"].includes(command)
  ) {
    throw new Error("Неизвестная команда. npm start -- --help");
  }
  if (!["telegram", "max", "whatsapp", "vk"].includes(values.provider))
    throw new Error(`Провайдер ${values.provider} пока не реализован.`);
  if (values.qr && command !== "login")
    throw new Error("--qr доступен только для login.");
  if (command === "send" && (!values.chat || !values.text?.trim()))
    throw new Error("Для send нужны --chat и --text.");
  if (!/^[a-zA-Z0-9_-]+$/.test(values.account))
    throw new Error("В --account допустимы буквы, цифры, _ и -.");
  const registry = new ProviderRegistry();
  if (values.provider === "max") {
    registry.register(
      new MaxProvider(
        values.account,
        process.env.MAX_SESSION_FILE || `.data/${values.account}.max.db`,
      ),
    );
  } else if (values.provider === "whatsapp") {
    registry.register(
      new WhatsAppProvider(
        values.account,
        process.env.WHATSAPP_SESSION_DIR || `.data/${values.account}.whatsapp`,
      ),
    );
  } else if (values.provider === "vk") {
    registry.register(
      new VkProvider(values.account, {
        sessionFile:
          process.env.VK_SESSION_FILE || `.data/${values.account}.vk.json`,
        token: process.env.VK_ACCESS_TOKEN,
        appId: process.env.VK_APP_ID,
      }),
    );
  } else {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH ?? "";
    if (
      !Number.isSafeInteger(apiId) ||
      apiId <= 0 ||
      !/^[a-f\d]{32}$/i.test(apiHash)
    ) {
      throw new Error(
        "Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH в .env (my.telegram.org).",
      );
    }
    const telegram = new TelegramProvider(values.account, {
      apiId,
      apiHash,
      phone: process.env.TELEGRAM_PHONE,
      sessionFile:
        process.env.TELEGRAM_SESSION_FILE ||
        `.data/${values.account}.telegram.session`,
    });
    registry.register(telegram);
  }
  const webhook = values.webhook ?? (process.env.WEBHOOK_URL || undefined);
  if (webhook && !["http:", "https:"].includes(new URL(webhook).protocol))
    throw new Error("Webhook должен быть HTTP(S).");
  const provider = registry.get(values.provider, values.account);
  try {
    await provider.connect();
    if (command === "login") {
      await provider.login({ method: values.qr ? "qr" : "phone" });
      console.error(
        "Сессия сохранена. Теперь можно выполнить chats или listen.",
      );
    } else if (command === "chats") {
      console.log(JSON.stringify(await provider.listChats(), null, 2));
    } else if (command === "send") {
      console.log(
        JSON.stringify(await provider.sendMessage(values.chat!, values.text!)),
      );
    } else {
      await provider.requireAuthorization();
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      let failure: unknown;
      let pending = Promise.resolve();
      let queued = 0;
      const stopErrors = provider.onError?.((error) => {
        failure = error;
        stop.abort();
      });
      const unsubscribe = provider.subscribe((message) => {
        if (
          stop.signal.aborted ||
          (values.chat && message.chatId !== values.chat)
        )
          return;
        if (queued >= 100) {
          failure = new Error("Очередь доставки переполнена.");
          stop.abort();
          return;
        }
        queued++;
        pending = pending
          .then(async () => {
            if (failure) return;
            if (webhook)
              await deliverWebhook(webhook, message, process.env.WEBHOOK_TOKEN);
            await writeMessage(process.stdout, message, stop.signal);
          })
          .catch((error: unknown) => {
            failure = error;
            stop.abort();
          })
          .finally(() => {
            queued--;
          });
      });
      console.error("Ожидание входящих сообщений. Ctrl+C для выхода.");
      try {
        if (!stop.signal.aborted) await once(stop.signal, "abort");
      } finally {
        unsubscribe();
        stopErrors?.();
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        await pending;
      }
      if (failure) throw failure;
    }
  } finally {
    await provider.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Неизвестная ошибка");
  process.exitCode = 1;
});
