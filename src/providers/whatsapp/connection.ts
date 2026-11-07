import { Agent } from "node:https";
import { Browsers } from "@whiskeysockets/baileys";

const proxyAgent = process.env.HTTPS_PROXY
  ? new Agent({ proxyEnv: process.env })
  : undefined;

export function connectionOptions() {
  return {
    agent: proxyAgent,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    connectTimeoutMs: 25_000,
  };
}
