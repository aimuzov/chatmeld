import type { AuthenticationCreds } from "@whiskeysockets/baileys";

export function hasSession(creds: AuthenticationCreds): boolean {
  return !!creds.me?.id;
}
