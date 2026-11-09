export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function assertImageActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Image read cancelled", "AbortError");
}

/** Check bytes before decoding. PNG screenshots also have a decoded pixel budget. */
export function inspectImage(data: Buffer, mimeType: string, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid image byte limit");
  if (data.length > maxBytes) throw new Error("Image exceeds the configured byte limit");
  const signature =
    mimeType === "image/png"
      ? data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : mimeType === "image/jpeg"
        ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : mimeType === "image/gif"
          ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))
          : mimeType === "image/webp" &&
            data.subarray(0, 4).toString("ascii") === "RIFF" &&
            data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!signature) throw new Error("Image header does not match its format");
  if (mimeType !== "image/png") return {};
  if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.subarray(12, 16).toString() !== "IHDR")
    throw new Error("Invalid PNG header");
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  if (!width || !height || width * height > MAX_IMAGE_PIXELS)
    throw new Error("PNG exceeds the decoded pixel limit");
  return { width, height };
}

export function imageMimeType(extension: string): ImageMimeType {
  const types: Record<string, ImageMimeType> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp"
  };
  const type = types[extension.toLowerCase()];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 扩展名由文件路径决定，未知扩展名在运行期返回 undefined，声明类型没有表达这一点
  if (!type) throw new Error("read_image supports PNG, JPEG, GIF and WebP");
  return type;
}
