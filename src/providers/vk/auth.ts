export function parseToken(input: string, expectedState?: string): string {
  if (typeof input !== "string")
    throw new Error("Некорректный пользовательский токен VK.");
  let token = input.trim();
  if (token.startsWith("https://")) {
    const url = new URL(token);
    if (
      !["oauth.vk.com", "oauth.vk.ru"].includes(url.hostname) ||
      url.pathname !== "/blank.html"
    )
      throw new Error("Ожидается адрес подтверждения OAuth VK.");
    const params = new URLSearchParams(url.hash.slice(1));
    if (expectedState && params.get("state") !== expectedState)
      throw new Error(
        "OAuth state не совпадает. Повторите вход по выданной ссылке.",
      );
    token = params.get("access_token") ?? "";
  }
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(token))
    throw new Error("Некорректный пользовательский токен VK.");
  return token;
}
