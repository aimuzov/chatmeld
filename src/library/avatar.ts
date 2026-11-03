import { AdapterError } from "./errors.js";
import type { Avatar } from "./types.js";

const limit = 256 * 1024;
const failed = () =>
  new AdapterError(
    "PROVIDER_ERROR",
    "Не удалось получить изображение аватарки.",
  );

export function inferAvatar(data: Uint8Array): Avatar {
  if (!data.length || data.length > limit) throw failed();
  const bytes = Buffer.from(data);
  let mimeType: string;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    mimeType = "image/jpeg";
  else if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mimeType = "image/png";
  else if (
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  )
    mimeType = "image/gif";
  else if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    mimeType = "image/webp";
  else throw failed();
  return { data: new Uint8Array(data), mimeType };
}

export async function downloadAvatar(
  url: string | undefined,
  allowedHosts: readonly string[],
  signal?: AbortSignal,
): Promise<Avatar | undefined> {
  if (!url) return undefined;
  const control = AbortSignal.timeout(15_000);
  const signals = signal ? AbortSignal.any([signal, control]) : control;
  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (
        current.protocol !== "https:" ||
        current.username ||
        current.password ||
        (current.port && current.port !== "443") ||
        !allowedHosts.some(
          (host) =>
            current.hostname === host.replace(/^\./, "") ||
            current.hostname.endsWith("." + host.replace(/^\./, "")),
        )
      )
        throw failed();
      const response = await fetch(current, {
        redirect: "manual",
        signal: signals,
      });
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        return undefined;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = response.headers.get("location");
        if (!next) throw failed();
        current = new URL(next, current);
        continue;
      }
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > limit
      ) {
        await response.body?.cancel();
        throw failed();
      }
      const reader = response.body?.getReader();
      if (!reader) throw failed();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > limit) throw failed();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      return inferAvatar(Buffer.concat(chunks));
    }
    throw failed();
  } catch {
    throw failed();
  }
}
