import { Agent } from "node:https";
import { Browsers } from "@whiskeysockets/baileys";
import { AdapterError } from "../../library/errors.js";

export function connectionOptions() {
  const proxy = process.env.HTTPS_PROXY;
  const [major, minor = 0] = process.versions.node.split(".").map(Number);
  if (proxy && major === 24 && minor < 5)
    throw new AdapterError(
      "INVALID_OPTIONS",
      "Для HTTPS_PROXY в WhatsApp нужен Node.js 24.5 или новее.",
    );
  return {
    agent: proxy ? new Agent({ proxyEnv: process.env }) : undefined,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    connectTimeoutMs: 25_000,
  };
}
