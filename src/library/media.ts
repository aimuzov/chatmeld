import { AdapterError } from "./errors.js";
import type { MediaFile, MediaInput, ProviderKind } from "./types.js";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const invalid = () =>
  new AdapterError(
    "INVALID_OPTIONS",
    "Некорректное медиа или ссылка вложения.",
  );
const failed = () =>
  new AdapterError("PROVIDER_ERROR", "Не удалось скачать медиафайл.");
const unavailable = () =>
  new AdapterError(
    "UNSUPPORTED_OPERATION",
    "Медиафайл недоступен или превышает лимит размера.",
  );

export function encodeMediaReference(
  provider: ProviderKind,
  accountId: string,
  payload: unknown,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, provider, accountId, payload }),
  ).toString("base64url");
}
export function decodeMediaReference(
  reference: string,
  provider: ProviderKind,
  accountId: string,
): Record<string, unknown> {
  try {
    if (typeof reference !== "string" || reference.length > 1_048_576)
      throw invalid();
    const value = JSON.parse(
      Buffer.from(reference, "base64url").toString("utf8"),
    );
    if (
      value.version !== 1 ||
      value.provider !== provider ||
      value.accountId !== accountId ||
      !value.payload ||
      typeof value.payload !== "object" ||
      Array.isArray(value.payload)
    )
      throw invalid();
    return value.payload;
  } catch {
    throw invalid();
  }
}

export function validateMedia(input: MediaInput): void {
  const prefixes = { photo: "image/", video: "video/", audio: "audio/" };
  if (
    !input ||
    !["photo", "video", "audio"].includes(input.kind) ||
    !(input.data instanceof Uint8Array) ||
    !input.data.length ||
    input.data.length > MAX_MEDIA_BYTES ||
    typeof input.mimeType !== "string" ||
    input.mimeType.length > 100 ||
    /[\r\n]/.test(input.mimeType) ||
    !input.mimeType.startsWith(prefixes[input.kind]) ||
    input.mimeType === "image/svg+xml" ||
    (input.fileName !== undefined &&
      (typeof input.fileName !== "string" ||
        input.fileName.length > 255 ||
        /[\x00-\x1f]/.test(input.fileName))) ||
    (input.caption !== undefined &&
      (typeof input.caption !== "string" || input.caption.length > 4096))
  )
    throw invalid();
}

export function mediaFileName(media: MediaInput): string {
  const supplied = media.fileName?.replaceAll("\\", "/").split("/").pop();
  if (supplied && supplied !== "." && supplied !== "..") return supplied;
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
  };
  return `media.${extensions[media.mimeType.split(";")[0]!] ?? (media.kind === "photo" ? "jpg" : media.kind === "video" ? "mp4" : "ogg")}`;
}

export async function collectMedia(
  stream: AsyncIterable<Uint8Array>,
  mimeType: string,
  fileName?: string,
): Promise<MediaFile> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_MEDIA_BYTES) throw unavailable();
    chunks.push(chunk);
  }
  if (!size) throw failed();
  return {
    data: new Uint8Array(Buffer.concat(chunks)),
    mimeType,
    ...(fileName ? { fileName } : {}),
  };
}

export async function downloadMediaUrl(
  url: string,
  allowedHosts: readonly string[],
  options: { signal?: AbortSignal; mimeType?: string; fileName?: string } = {},
): Promise<MediaFile> {
  try {
    let current = new URL(url);
    const timeout = AbortSignal.timeout(120_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
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
      const response = await fetch(current, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw failed();
        current = new URL(location, current);
        continue;
      }
      if (
        [404, 410].includes(response.status) ||
        Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES
      ) {
        await response.body?.cancel();
        throw unavailable();
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw failed();
      }
      const responseType = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        responseType &&
        ["text/html", "application/xhtml+xml", "image/svg+xml"].includes(
          responseType,
        )
      ) {
        await response.body.cancel();
        throw failed();
      }
      const mimeType =
        responseType && /^(?:image|audio|video)\//.test(responseType)
          ? responseType
          : (options.mimeType ?? responseType ?? "application/octet-stream");
      return await collectMedia(response.body, mimeType, options.fileName);
    }
    throw failed();
  } catch (error) {
    if (error instanceof AdapterError && error.code === "UNSUPPORTED_OPERATION")
      throw error;
    throw failed();
  }
}
