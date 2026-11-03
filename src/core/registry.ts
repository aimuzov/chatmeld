import type { MessagingProvider } from "./provider.js";

export class ProviderRegistry {
  private providers = new Map<string, MessagingProvider>();

  register(provider: MessagingProvider): void {
    const key = `${provider.kind}:${provider.accountId}`;
    if (this.providers.has(key))
      throw new Error(`Аккаунт уже зарегистрирован: ${key}`);
    this.providers.set(key, provider);
  }

  get(kind: string, accountId: string): MessagingProvider {
    const provider = this.providers.get(`${kind}:${accountId}`);
    if (!provider)
      throw new Error(
        `Провайдер ${kind} для аккаунта ${accountId} не подключён.`,
      );
    return provider;
  }
}
