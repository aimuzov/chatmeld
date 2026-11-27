import { channel } from "node:diagnostics_channel";

export const providerFailures = channel("chatmeld.provider.failure");

export function providerFailure(
  provider: "instagram" | "vk" | "whatsapp",
  accountId: string,
  stage: string,
  reason: string,
  status?: number,
) {
  providerFailures.publish({ provider, accountId, stage, reason, status });
}
