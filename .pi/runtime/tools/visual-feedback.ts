import { createImageArchive, type ImageSource } from "../../../dist/src/tools/image-archive.js";
import type { RuntimeToolResult } from "../helpers.ts";

/** Archive observed pixels as evidence; only the live backend supplies action credentials. */
export function createVisualFeedback(taskDirectory: string) {
  const archive = createImageArchive({ taskDirectory });
  return async function feedback(
    result: Record<string, unknown>,
    supportsImages: boolean,
    source: ImageSource,
    signal?: AbortSignal
  ): Promise<RuntimeToolResult> {
    const { image, ...metadata } = result;
    const delivered = supportsImages && typeof image === "string";
    let history: Record<string, unknown> = {};
    if (typeof image === "string") {
      signal?.throwIfAborted();
      try {
        const record = await archive.put({
          data: Buffer.from(image, "base64"),
          mimeType: "image/png",
          source,
          signal
        });
        history = { imageRef: record.imageRef, imageHash: record.imageHash };
      } catch (error) {
        signal?.throwIfAborted();
        // A full archive must not hide current feedback or change input delivery status.
        history = {
          imageArchive: {
            saved: false,
            error: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }
    const details = {
      ...metadata,
      ...history,
      visualFeedback: { delivered },
      ...(!delivered
        ? { reason: "当前模型不支持图像输入；请使用结构化控件或页面文本，不能猜测点击坐标" }
        : {})
    };
    return {
      content: [
        { type: "text", text: JSON.stringify(details) },
        ...(delivered ? [{ type: "image" as const, mimeType: "image/png", data: image }] : [])
      ],
      details
    };
  };
}
