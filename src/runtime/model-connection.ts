import { createModelStreams, modelThinkingLevel } from "./model-provider.js";
import { createHttpTransport } from "./http-transport.js";
import { randomInt } from "node:crypto";
import {
  createModels,
  createProvider,
  Type,
  type ImageContent,
  type TextContent
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  connectionProfile,
  createCoworkModel,
  parseConnectionProfile,
  type ConnectionProfile
} from "./model-profile.js";
import { deflateSync } from "node:zlib";
import { modelErrorCode, responseModelErrorCode } from "./model-error.js";

export interface ModelConnectionInput extends Partial<ConnectionProfile> {
  baseUrl: string;
  model: string;
  apiKey: string;
  supportsImages?: boolean;
}

interface VisionFixture {
  imageUrl: string;
  code: string;
}
interface ConnectionTestOptions {
  visionFixture?: () => VisionFixture;
}

// The challenge answer exists only in generated pixels, never in the prompt/schema.
// A color-only probe can accidentally pass when a model guesses its fixed color.
function createVisionFixture(): VisionFixture {
  const code = randomInt(2) === 0 ? "2" : "4";
  const glyphs = {
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"]
  };
  const width = 192,
    height = 192,
    scale = 16,
    stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * stride + x * 3 + 1;
      pixels[index] = 37;
      pixels[index + 1] = 99;
      pixels[index + 2] = 235;
    }
  const glyph = glyphs[code];
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 5; x++) {
      if (glyph[y][x] !== "1") continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const index = (40 + y * scale + dy) * stride + (56 + x * scale + dx) * 3 + 1;
          pixels.fill(255, index, index + 3);
        }
    }
  const chunk = (type: string, data: Buffer) => {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0);
    output.write(type, 4, "ascii");
    data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, output.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ]);
  return { imageUrl: `data:image/png;base64,${png.toString("base64")}`, code };
}

/** Test the actual Pi streaming transport and runtime parameters without executing user tools. */
export async function testModelConnection(input: ModelConnectionInput, options: ConnectionTestOptions = {}) {
  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    throw new Error("请填写有效的 API 地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("API 地址需为不含凭据、查询参数或片段的 HTTP(S) 地址");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(input.model)) throw new Error("请填写有效的模型 ID");
  if (!input.apiKey || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey))
    throw new Error("请填写有效的 API Key");
  if (input.supportsImages !== undefined && typeof input.supportsImages !== "boolean")
    throw new Error("图像能力设置必须为布尔值");
  const profile = parseConnectionProfile({ ...input }, connectionProfile(input));
  const format = profile.api === "openai-responses" ? "Responses" : "Chat Completions";
  const fixture = input.supportsImages ? (options.visionFixture ?? createVisionFixture)() : undefined;
  const started = Date.now();
  const content: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: "Call atria_connection_check with status connected. If an image is attached, identify its background color (blue, red or green) and read the single large digit shown in the image. Without an image, use color none and code none."
    }
  ];
  if (fixture) {
    const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(fixture.imageUrl);
    if (!match) throw new Error("连接测试图片格式无效");
    content.push({ type: "image", mimeType: match[1], data: match[2] });
  }
  const transport = createHttpTransport();
  let status: number | undefined;
  let providerCode: "model_not_found" | undefined;
  let result;
  try {
    const model = createCoworkModel({
      ...input,
      api: profile.api,
      thinkingFormat: profile.thinkingFormat,
      baseUrl: url.href,
      maxTokens: profile.mainMaxTokens,
      contextWindow: profile.contextWindow,
      supportsReasoningEffort: profile.supportsReasoningEffort
    });
    const models = createModels();
    models.setProvider(
      createProvider({
        id: model.provider,
        name: "CoworkOS model service",
        baseUrl: model.baseUrl,
        auth: {
          apiKey: { name: "CoworkOS API key", resolve: async () => ({ auth: { apiKey: input.apiKey } }) }
        },
        models: [model],
        api: createModelStreams(model.api, {
          supportsPromptCacheKey: profile.supportsPromptCacheKey,
          sessionId: "atria-connection-check"
        })
      })
    );
    const thinkingLevel = modelThinkingLevel(model, profile.reasoningEffort);
    const stream = models.streamSimple(
      model,
      normalizeContext({
        systemPrompt: "Verify the connection by calling the supplied test tool. Do not perform other work.",
        messages: [{ role: "user", content, timestamp: Date.now() }],
        tools: [
          {
            name: "atria_connection_check",
            description: "Verify model tool calling and optional image input.",
            parameters: Type.Object(
              {
                status: Type.Literal("connected"),
                color: Type.Union([
                  Type.Literal("blue"),
                  Type.Literal("red"),
                  Type.Literal("green"),
                  Type.Literal("none")
                ]),
                code: Type.String({
                  description: "Single digit visible in the image, or none without an image."
                })
              },
              { additionalProperties: false }
            )
          }
        ]
      }),
      {
        apiKey: input.apiKey,
        reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
        maxTokens: profile.mainMaxTokens,
        maxRetries: 0,
        signal: AbortSignal.timeout(45000),
        fetch: async (request, init) => {
          const response = await transport.fetch(request, { ...init, redirect: "error" });
          status = response.status;
          if (status === 404) providerCode = await responseModelErrorCode(response);
          return response;
        }
      }
    );
    result = await stream.result();
  } catch {
    throw new Error(`连接失败或超时，请检查 API 地址、网络及服务的流式 ${format} 支持`);
  } finally {
    await transport.close();
  }
  if (status === 401 || status === 403) throw new Error("认证失败，请检查 API Key 和模型访问权限");
  if (status === 429) throw new Error("服务请求受限，请检查额度或稍后重试");
  if (status !== undefined && status >= 500)
    throw new Error(`模型服务暂时不可用（HTTP ${status}），请稍后重试或联系服务商`);
  if (status === 404)
    throw new Error(
      (providerCode ?? modelErrorCode(result.errorMessage)) === "model_not_found"
        ? "服务返回 HTTP 404：当前 API 账号或分组无法使用此模型，请确认服务商的模型权限及可用状态，或选择可用的模型后重试"
        : "服务返回 HTTP 404：请求的接口或模型未找到，请检查 API 地址、模型 ID 及服务商的模型可用状态"
    );
  if (status !== undefined && status >= 400)
    throw new Error(
      `服务返回 HTTP ${status}，请检查消息格式、模型 ID、输出上限、推理参数、工具调用${input.supportsImages ? "和图像输入" : ""}支持`
    );
  // Provider errors and JSON parser diagnostics may contain secrets. Never forward them.
  if (result.stopReason === "error" || result.stopReason === "aborted")
    throw new Error(
      status === undefined
        ? "连接失败或超时，请检查 API 地址和网络"
        : `服务未返回有效的流式 ${format} JSON 或工具调用，请检查消息格式、参数和流式支持`
    );
  const calls = result.content.filter((block) => block.type === "toolCall");
  const call = calls.find((block) => block.name === "atria_connection_check");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 工具调用由服务商响应体解析而来，SDK 类型声明 id 必填但实际可能缺失
  if (result.stopReason !== "toolUse" || calls.length !== 1 || !call?.id?.trim())
    throw new Error("模型未返回有效的工具调用，当前连接无法用于 Agent 任务");
  const args = call.arguments;
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 工具参数同样来自服务商响应，arguments 可能是 null 而不是对象
    !args ||
    args.status !== "connected" ||
    typeof args.color !== "string" ||
    !["blue", "red", "green", "none"].includes(args.color) ||
    typeof args.code !== "string" ||
    Object.keys(args).some((key) => !["status", "color", "code"].includes(key))
  )
    throw new Error("模型未完成有效的工具调用，当前连接无法用于 Agent 任务");
  if (!input.supportsImages && (args.color !== "none" || args.code !== "none"))
    throw new Error("模型返回的工具参数与测试请求不符，请重试连接测试");
  if (fixture && (args.color !== "blue" || args.code !== fixture.code))
    throw new Error("工具调用通过，但模型未正确识别测试图片；请检查图像支持或取消图像输入选项");
  return {
    ok: true,
    model: input.model,
    supportsImages: input.supportsImages === true,
    streaming: true,
    durationMs: Date.now() - started
  };
}
