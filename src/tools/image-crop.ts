import { PNG } from "pngjs";
import { assertImageActive, DEFAULT_MAX_IMAGE_BYTES, inspectImage, MAX_IMAGE_PIXELS } from "./image-data.js";
import type { ImageRegion } from "./image-archive.js";

/** Screenshot crops use PNG pixel coordinates, preserving sharp UI edges. */
export function cropPng(input: {
  data: Buffer;
  region: ImageRegion;
  scale?: number;
  maxImageBytes?: number;
  signal?: AbortSignal;
}) {
  assertImageActive(input.signal);
  const limit = input.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const dimensions = inspectImage(input.data, "image/png", limit);
  const region = input.region,
    scale = input.scale ?? 1;
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- region 来自工具参数，运行期可能是缺失或非对象的 region，索引前必须校验
    !region ||
    ![region.x, region.y].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    ![region.width, region.height].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Crop region requires integer x/y >= 0 and width/height > 0");
  if (region.x + region.width > dimensions.width! || region.y + region.height > dimensions.height!)
    throw new Error("Crop region is outside the source image");
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 8) throw new Error("Crop scale must be 0.25–8");
  const width = Math.max(1, Math.round(region.width * scale)),
    height = Math.max(1, Math.round(region.height * scale));
  if (width * height > MAX_IMAGE_PIXELS) throw new Error("Crop exceeds the decoded pixel limit");
  let source: PNG;
  try {
    source = PNG.sync.read(input.data, { checkCRC: true });
  } catch {
    throw new Error("PNG could not be decoded for cropping");
  }
  assertImageActive(input.signal);
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    assertImageActive(input.signal);
    const sourceY = region.y + Math.floor((y * region.height) / height);
    for (let x = 0; x < width; x++) {
      const sourceX = region.x + Math.floor((x * region.width) / width);
      const index = (sourceY * source.width + sourceX) * 4;
      source.data.copy(output.data, (y * width + x) * 4, index, index + 4);
    }
  }
  const data = PNG.sync.write(output);
  if (data.length > limit) throw new Error("Cropped PNG exceeds the configured byte limit");
  assertImageActive(input.signal);
  return {
    data,
    width,
    height,
    scaleX: width / region.width,
    scaleY: height / region.height,
    sourceWidth: source.width,
    sourceHeight: source.height
  };
}
