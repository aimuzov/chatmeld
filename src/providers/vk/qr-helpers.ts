import jsQR from "jsqr";
import { PNG } from "pngjs";
import { parseToken } from "./auth.js";

export function tokenFromVkRequest(
  url: string,
  body?: string | null,
  authorization?: string,
): string | undefined {
  try {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      !["api.vk.ru", "api.vk.com", "web.api.vk.ru", "web.api.vk.com"].includes(
        target.hostname,
      ) ||
      !/^\/method\/(messages\.[A-Za-z]+|execute)$/.test(target.pathname)
    )
      return;
    let token = target.searchParams.get("access_token");
    if (!token && body) {
      if (body.trim().startsWith("{"))
        token =
          (JSON.parse(body) as { access_token?: string }).access_token ?? null;
      else token = new URLSearchParams(body).get("access_token");
    }
    token ||= authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
    return token ? parseToken(token) : undefined;
  } catch {
    return;
  }
}

export function decodeVkQr(image: Buffer): string | undefined {
  try {
    const png = PNG.sync.read(image);
    const value = jsQR.default(
      new Uint8ClampedArray(png.data),
      png.width,
      png.height,
    )?.data;
    if (!value) return;
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      ["qr.vk.ru", "qr.vk.com", "id.vk.ru", "id.vk.com"].includes(url.hostname)
    )
      return value;
  } catch {
    return;
  }
}
