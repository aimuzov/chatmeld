import { Browsers } from "@whiskeysockets/baileys";

export function connectionOptions() {
  return {
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    connectTimeoutMs: 25_000,
  };
}
