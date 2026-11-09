import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { containsFilePath } from "./file-path.js";
import { createVisionAnalyzer, type VisionModelConfig } from "./vision-model.js";
import {
  createImageArchive,
  type ImageMapping,
  type ImageRecord,
  type ImageRegion
} from "./image-archive.js";
import { cropPng } from "./image-crop.js";
import {
  assertImageActive,
  DEFAULT_MAX_IMAGE_BYTES,
  imageMimeType,
  inspectImage,
  type ImageMimeType
} from "./image-data.js";

export interface ImageReaderOptions {
  rootDirectory: string;
  taskDirectory?: string;
  workScope?: "work" | "project";
  supportsImages?: boolean;
  visionModel?: VisionModelConfig;
  analyze?: ReturnType<typeof createVisionAnalyzer>;
  maxImageBytes?: number;
  maxBatchBytes?: number;
  resolveWorkPath?: (path: string) => Promise<string>;
}
interface ImageInput {
  path?: unknown;
  scope?: unknown;
  imageRef?: unknown;
}
interface LoadedImage {
  data: Buffer;
  mimeType: ImageMimeType;
  path: string;
  scope: string;
  record?: ImageRecord;
}
const sourceProperties = {
  path: {
    type: ["string", "null"],
    description:
      'Single image file path, relative or absolute inside the selected root. Specify exactly one non-empty path or imageRef; omit this field or set null/"" when using the other source.'
  },
  imageRef: {
    type: ["string", "null"],
    description:
      'Historical imageRef from this Task. Specify exactly one non-empty path or imageRef; omit this field or set null/"" when using the other source.'
  }
};

/** One implementation shared by Main extension and programmatic/delegated Pi tools. */
export function createImageTools(options: ImageReaderOptions) {
  const analyze = options.analyze ?? createVisionAnalyzer();
  const workScope = options.workScope ?? "work";
  const archive = options.taskDirectory
    ? createImageArchive({ taskDirectory: options.taskDirectory, maxImageBytes: options.maxImageBytes })
    : undefined;
  const limit = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const batchLimit = options.maxBatchBytes ?? 40 * 1024 * 1024;
  const scopeProperty = { type: "string", enum: [workScope, "task"] };
  const sourceSchema = {
    type: "object",
    properties: { ...sourceProperties, scope: scopeProperty },
    additionalProperties: false
  };
  const direct = options.supportsImages
    ? "Returns pixels directly."
    : `Returns evidence from the configured vision connection (${options.visionModel?.model ?? "not configured"}).`;
  function object(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Image tool requires an object");
    return input as Record<string, unknown>;
  }
  function reviewInput(input: Record<string, unknown>) {
    if (input.review !== undefined && typeof input.review !== "boolean")
      throw new Error("review must be a boolean");
    if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.length > 4000))
      throw new Error("goal must be at most 4000 characters");
    return { goal: input.goal, review: input.review === true };
  }
  async function load(input: ImageInput, signal?: AbortSignal): Promise<LoadedImage> {
    assertImageActive(signal);
    // Some models fill optional source fields with empty strings or null. These
    // represent absence; preserve every non-empty value for normal validation.
    const absent = (value: unknown) =>
      value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    const pathInput = absent(input.path) ? undefined : input.path,
      imageRef = absent(input.imageRef) ? undefined : input.imageRef;
    if ((pathInput !== undefined) === (imageRef !== undefined))
      throw new Error("Specify exactly one path or imageRef");
    if (imageRef !== undefined) {
      if (typeof imageRef !== "string") throw new Error("imageRef must be a string");
      if (input.scope !== undefined && input.scope !== "task")
        throw new Error("imageRef belongs to scope=task");
      if (!archive) throw new Error("Shared Task image archive is unavailable");
      const { record, data } = await archive.read(imageRef, signal);
      return { data, mimeType: record.mimeType, path: record.imageRef, scope: "task", record };
    }
    if (typeof pathInput !== "string")
      throw new Error("Image path must be a relative or in-root absolute string");
    if (input.scope !== undefined && input.scope !== workScope && input.scope !== "task")
      throw new Error("Invalid image scope");
    const task = input.scope === "task",
      requestedRoot = task ? options.taskDirectory : options.rootDirectory;
    if (!requestedRoot) throw new Error("Shared Task image scope is unavailable");
    const root = await realpath(requestedRoot);
    let selectedPath = pathInput;
    if (isAbsolute(pathInput)) {
      const canonical = await realpath(pathInput).catch(() => {
        throw new Error("Image path must be relative or an existing absolute file inside its allowed root");
      });
      if (!containsFilePath(root, canonical)) throw new Error("Image path escapes its allowed root");
      selectedPath = relative(root, canonical);
    }
    let path: string;
    if (!task && options.resolveWorkPath) path = await options.resolveWorkPath(selectedPath);
    else {
      path = await realpath(resolve(root, selectedPath));
      if (!containsFilePath(root, path)) throw new Error("Image path escapes its allowed root");
    }
    assertImageActive(signal);
    const mimeType = imageMimeType(extname(path));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit)
        throw new Error("Image must be a file within the configured byte limit");
      const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let offset = 0;
      while (offset < buffer.length) {
        assertImageActive(signal);
        const chunk = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!chunk.bytesRead) break;
        offset += chunk.bytesRead;
      }
      if (offset !== info.size) throw new Error("Image changed while reading; render a fresh image");
      data = buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
    inspectImage(data, mimeType, limit);
    assertImageActive(signal);
    return { data, mimeType, path: relative(root, path), scope: task ? "task" : workScope };
  }
  async function remember(image: LoadedImage, signal?: AbortSignal) {
    if (!image.record && archive)
      image.record = await archive.put({
        data: image.data,
        mimeType: image.mimeType,
        source: { kind: "file", label: image.path },
        signal
      });
    return image;
  }
  function evidence(image: LoadedImage) {
    const dimensions = inspectImage(image.data, image.mimeType, limit);
    const details = {
      path: image.path,
      scope: image.scope,
      mimeType: image.mimeType,
      bytes: image.data.length,
      imageHash: createHash("sha256").update(image.data).digest("hex"),
      ...dimensions,
      ...(image.record
        ? {
            imageRef: image.record.imageRef,
            historical: true,
            ...(image.record.mapping ? { mapping: image.record.mapping } : {})
          }
        : {})
    };
    return details;
  }
  async function result(
    images: LoadedImage[],
    review: ReturnType<typeof reviewInput>,
    shape: "single" | "paths" | "images",
    signal?: AbortSignal
  ) {
    assertImageActive(signal);
    if (review.review && images.length > 1)
      throw new Error("Visual QA must review one page at a time; compare images without review=true");
    for (const image of images) await remember(image, signal);
    const records = images.map(evidence);
    const mode = options.supportsImages ? "direct" : "fallback";
    const details =
      shape === "single"
        ? records[0]
        : {
            images: records.map((record) => ({ ...record, mode })),
            ...(shape === "images"
              ? { count: images.length, bytes: images.reduce((sum, image) => sum + image.data.length, 0) }
              : {})
          };
    if (options.supportsImages)
      return {
        content: images.flatMap((image, index) => {
          const loaded = {
            type: "image" as const,
            data: image.data.toString("base64"),
            mimeType: image.mimeType
          };
          const metadata = JSON.stringify(records[index]);
          if (shape === "paths")
            return [
              { type: "text" as const, text: `Image ${index + 1}: ${image.path}` },
              loaded,
              { type: "text" as const, text: metadata }
            ];
          return [
            ...(shape === "images"
              ? [{ type: "text" as const, text: `Image ${index + 1} of ${images.length}` }]
              : []),
            { type: "text" as const, text: `Image loaded: ${image.path}\n${metadata}` },
            loaded
          ];
        }),
        details: { ...details, mode: "direct" as const }
      };
    if (!options.visionModel)
      throw new Error("Current model is text-only; choose an image-analysis connection in model settings");
    const analysis = await analyze(
      options.visionModel,
      {
        data: images[0].data,
        mimeType: images[0].mimeType,
        path: images[0].path,
        additionalImages: images.slice(1).map(({ data, mimeType, path }) => ({ data, mimeType, path })),
        ...review
      },
      signal
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Vision analysis for ${images.map((image) => image.path).join(", ")}:\n${analysis.report}\n${JSON.stringify(details)}`
        }
      ],
      details: {
        ...details,
        mode: "fallback" as const,
        visionModel: options.visionModel.model,
        elapsedMs: analysis.elapsedMs,
        cached: analysis.cached,
        review: analysis.review
      }
    };
  }
  const reviewProperties = { goal: { type: "string", maxLength: 4000 }, review: { type: "boolean" } };
  return {
    read_image: {
      executionMode: "parallel" as const,
      description: `Inspect local PNG, JPEG, GIF or WebP files, or reread a historical Task imageRef. Prefer paths:["image.png"] for one image or an ordered comparison of 1–4 images (20 MiB total). path is a single-image alias; matching path and paths:[path] read it once. Specify exactly one non-empty path/paths selection or imageRef; omit unused sources or set path/imageRef to null/"". ${direct} Text-only models use one ordered comparison request. Use review=true for one-page structured visual QA. Paths are relative to scope=${workScope} or the shared Task (scope=task); absolute paths inside the selected root are also accepted. Historical pixels do not authorize Computer Use actions.`,
      parameters: {
        ...sourceSchema,
        properties: {
          ...sourceSchema.properties,
          paths: {
            type: "array",
            items: { type: "string" },
            minItems: 0,
            maxItems: 4,
            description:
              "Use 1–4 non-empty relative image paths, or absolute paths inside the selected root. An empty list is ignored when another source is set."
          },
          ...reviewProperties
        }
      },
      async execute(input: unknown, signal?: AbortSignal) {
        const value = object(input),
          review = reviewInput(value);
        const absent = (input: unknown) =>
          input === undefined || input === null || (typeof input === "string" && !input.trim());
        if (!absent(value.path) && typeof value.path !== "string")
          throw new Error("path must be a relative image path string");
        if (
          value.paths !== undefined &&
          (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string"))
        )
          throw new Error("paths must be an array of relative image path strings");
        const suppliedPaths = value.paths as string[] | undefined;
        if (suppliedPaths && suppliedPaths.length > 4) throw new Error("paths must contain 1–4 images");
        const selectedPaths = suppliedPaths?.some((path) => path.trim()) ? suppliedPaths : undefined;
        const path = absent(value.path) ? undefined : (value.path as string);
        if (path && selectedPaths && (selectedPaths.length !== 1 || selectedPaths[0] !== path))
          throw new Error(
            "path and paths must select the same single image; omit path to use multiple paths"
          );
        if (selectedPaths && !absent(value.imageRef)) throw new Error("Specify exactly one path or imageRef");
        const paths = path ? [path] : selectedPaths;
        if (!paths) return result([await load(value, signal)], review, "single", signal);
        if (review.review && paths.length > 1)
          throw new Error("Visual QA must review one page at a time; compare images without review=true");
        const images: LoadedImage[] = [];
        let total = 0;
        for (const selected of paths) {
          const image = await load({ path: selected, imageRef: value.imageRef, scope: value.scope }, signal);
          total += image.data.length;
          if (paths.length > 1 && total > Math.min(batchLimit, 20 * 1024 * 1024))
            throw new Error("Image comparison exceeds the 20 MiB total byte limit");
          images.push(image);
        }
        return result(images, review, path ? "single" : "paths", signal);
      }
    },
    read_images: {
      description: `Inspect 1–4 local images or historical Task imageRefs together, in order, for comparison. Each image must specify exactly one non-empty path or imageRef; omit the unused source or set it to null/"". ${direct} Total pixels payload is bounded to ${batchLimit} bytes. Text-only models use one ordered comparison request. Use review=true for one image only.`,
      parameters: {
        type: "object",
        properties: {
          images: { type: "array", minItems: 1, maxItems: 4, items: sourceSchema },
          ...reviewProperties
        },
        required: ["images"],
        additionalProperties: false
      },
      async execute(input: unknown, signal?: AbortSignal) {
        const value = object(input),
          review = reviewInput(value);
        if (!Array.isArray(value.images) || value.images.length < 1 || value.images.length > 4)
          throw new Error("read_images requires 1–4 images");
        if (review.review && value.images.length > 1)
          throw new Error("Visual QA must review one page at a time; compare images without review=true");
        const loaded: LoadedImage[] = [];
        let total = 0;
        for (const item of value.images) {
          const image = await load(object(item), signal);
          total += image.data.length;
          if (total > batchLimit) throw new Error("Images exceed the combined byte limit");
          loaded.push(image);
        }
        return result(loaded, review, "images", signal);
      }
    },
    crop_image: {
      description: `Crop an existing PNG screenshot by integer pixel region {x,y,width,height}, then resize by scale (0.25–8; default 1). Specify exactly one non-empty path or imageRef; omit the unused source or set it to null/"". JPEG/GIF/WebP can be read but cannot be cropped here. Returns an archived imageRef and mapping: sourceX=region.x+outputX/scaleX, sourceY=region.y+outputY/scaleY. Historical crops are observation evidence; obtain a fresh computer_observe before actions. ${direct}`,
      parameters: {
        type: "object",
        properties: {
          ...sourceSchema.properties,
          region: {
            type: "object",
            properties: {
              x: { type: "integer", minimum: 0 },
              y: { type: "integer", minimum: 0 },
              width: { type: "integer", minimum: 1 },
              height: { type: "integer", minimum: 1 }
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false
          },
          scale: { type: "number", minimum: 0.25, maximum: 8 },
          ...reviewProperties
        },
        required: ["region"],
        additionalProperties: false
      },
      async execute(input: unknown, signal?: AbortSignal) {
        const value = object(input),
          review = reviewInput(value),
          image = await load(value, signal);
        if (image.mimeType !== "image/png")
          throw new Error("crop_image supports PNG screenshots only; use read_image for JPEG/GIF/WebP");
        if (value.scale !== undefined && typeof value.scale !== "number")
          throw new Error("Crop scale must be a number");
        const cropped = cropPng({
          data: image.data,
          region: value.region as ImageRegion,
          scale: value.scale,
          maxImageBytes: limit,
          signal
        });
        if (!archive) throw new Error("Shared Task image archive is unavailable");
        await remember(image, signal);
        const mapping: ImageMapping = {
          sourceImageRef: image.record!.imageRef,
          sourceWidth: cropped.sourceWidth,
          sourceHeight: cropped.sourceHeight,
          region: { ...(value.region as ImageRegion) },
          scaleX: cropped.scaleX,
          scaleY: cropped.scaleY
        };
        const record = await archive.put({
          data: cropped.data,
          mimeType: "image/png",
          source: { kind: "derived", label: image.record!.imageRef },
          mapping,
          signal
        });
        return result(
          [{ data: cropped.data, mimeType: "image/png", path: record.imageRef, scope: "task", record }],
          review,
          "single",
          signal
        );
      }
    },
    list_images: {
      description:
        "List recent archived Task images (default 20; maximum 50). imageRefs can be reread/cropped for visual comparison, never used as current Computer Use action credentials. Images are retained with Task data; archive limits preserve existing images and reject new writes.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        additionalProperties: false
      },
      async execute(input: unknown, signal?: AbortSignal) {
        const value = object(input);
        if (!archive) throw new Error("Shared Task image archive is unavailable");
        if (value.limit !== undefined && typeof value.limit !== "number")
          throw new Error("Image history limit must be a number");
        const images = await archive.list({ limit: value.limit, signal });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ images, historical: true }) }],
          details: { images, historical: true }
        };
      }
    }
  };
}

export function createReadImageTool(options: ImageReaderOptions) {
  return createImageTools(options).read_image;
}
