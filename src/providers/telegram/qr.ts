export function telegramLoginUrl(token: Buffer): string {
  return `tg://login?token=${token.toString("base64url")}`;
}
