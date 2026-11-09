/** Classify structured provider errors without exposing their message, headers or credentials. */
export function modelErrorCode(message: string | undefined): "model_not_found" | undefined {
  if (!message || message.length > 65536) return;
  const body = message.replace(/^(?:HTTP(?: status(?: code)?)?\s*[:=]?\s*)?[45]\d{2}\s*:?\s*/i, "");
  try {
    const value = JSON.parse(body);
    const error = value?.error ?? value;
    if (error?.type === "model_not_found" || error?.code === "model_not_found") return "model_not_found";
    // eslint-disable-next-line no-restricted-syntax -- 非结构化诊断正文不是服务商错误码的证据，解析失败就是不返回错误码
  } catch {
    // Unstructured diagnostics are not evidence of a provider error code.
  }
}

/** Some transports discard nonstandard error envelopes; inspect a bounded copy for the probe. */
export async function responseModelErrorCode(response: Response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  try {
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return modelErrorCode(body + decoder.decode());
      bytes += value.byteLength;
      if (bytes > 65536) return;
      body += decoder.decode(value, { stream: true });
    }
    // eslint-disable-next-line no-restricted-syntax -- 读取服务商错误正文失败时仍保留 HTTP 状态诊断，正文只是补充证据
  } catch {
    // Keep the HTTP diagnosis even when the provider body cannot be read.
  } finally {
    // eslint-disable-next-line no-restricted-syntax -- 探测结束后释放响应体，取消失败不影响已经得到的诊断结果
    void reader.cancel().catch(() => {});
  }
}
