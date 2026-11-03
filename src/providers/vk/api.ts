import { API, APIError, type APIRequest } from "vk-io";
import { setTimeout as delay } from "node:timers/promises";

export class CancellableVkApi extends API {
  constructor(
    options: ConstructorParameters<typeof API>[0],
    private signal: () => AbortSignal,
  ) {
    super(options);
  }

  override async callWithRequest<T = unknown>(request: APIRequest): Promise<T> {
    const body = new URLSearchParams({
      access_token: this.options.token,
      v: this.options.apiVersion,
    });
    for (const [key, value] of Object.entries(request.params)) {
      if (value !== undefined)
        body.set(
          key,
          Array.isArray(value)
            ? value.join(",")
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value),
        );
    }
    for (let attempt = 0; ; attempt++) {
      const signal = this.signal();
      const response = await fetch(
        `${this.options.apiBaseUrl}/${request.method}`,
        {
          method: "POST",
          body,
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(this.options.apiTimeout),
          ]),
        },
      );
      if (!response.ok) throw new Error("VK_API_HTTP_ERROR");
      const value = (await response.json()) as {
        response?: unknown;
        error?: { error_code: number; error_msg: string };
      };
      if (value.error) {
        if (value.error.error_code === 6 && attempt < 2) {
          await delay(500 * (attempt + 1), undefined, { signal });
          continue;
        }
        throw new APIError({ ...value.error, request_params: [] });
      }
      if (!("response" in value)) throw new Error("VK_API_INVALID_RESPONSE");
      return value.response as T;
    }
  }
}
