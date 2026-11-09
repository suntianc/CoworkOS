function policyCode(error) {
  const raw = typeof error === "string" ? error : error?.message || "";
  const start = raw.indexOf("{");
  if (start < 0) return;
  try {
    const body = JSON.parse(raw.slice(start));
    const code = (body?.error || body)?.code;
    if (["cyber_policy", "content_policy_violation", "content_filter"].includes(code)) return code;
    // eslint-disable-next-line no-restricted-syntax -- 错误文本里的 JSON 片段可能被截断，解析失败时按普通错误继续分类
  } catch {
    // Unstructured errors continue through the normal safe classification.
  }
}

/** Display only known categories, explicit HTTP statuses and allowlisted codes. */
export function modelErrorDiagnostic(error, httpStatus) {
  const raw = typeof error === "string" ? error : error?.message || "";
  const prefix =
    /^(?:HTTP(?: status(?: code)?)?\s*[:=]?\s*)?([45]\d{2})(?=\b|:)/i.exec(raw) ??
    /^[\w.-]+ API error \(([45]\d{2})\):/i.exec(raw);
  const status =
    Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
      ? httpStatus
      : prefix
        ? Number(prefix[1])
        : undefined;
  const code = policyCode(raw);
  const category = code
    ? "内容安全策略拒绝"
    : {
        400: "请求被拒绝",
        401: "身份认证失败",
        403: "访问权限不足",
        404: "接口或模型不存在",
        429: "请求限流",
        500: "模型服务内部错误",
        502: "模型网关错误",
        503: "模型服务暂不可用",
        504: "模型网关超时"
      }[status] || (status ? "模型服务请求失败" : undefined);
  return [category, status && `HTTP ${status}`, code].filter(Boolean).join(" · ");
}

/** Read only recognized structured codes; never display arbitrary provider bodies. */
export function modelPolicyRejection(error) {
  const code = policyCode(error);
  if (code === "cyber_policy")
    return "模型服务因网络安全内容策略拒绝了本次请求（cyber_policy）。本次请求包含历史上下文，直接重试可能仍被拒绝；如认为是误判，请联系模型服务方核查。";
  if (code === "content_policy_violation" || code === "content_filter")
    return "模型服务因内容安全策略拒绝了本次请求。本次请求包含历史上下文，直接重试可能仍被拒绝；如认为是误判，请联系模型服务方核查。";
}

export function requestErrorMessage(error) {
  const raw = typeof error === "string" ? error : error?.message || "请求未能完成";
  const policy = modelPolicyRejection(raw);
  if (policy) return policy;
  if (/\b401\b|authentication_error|认证失败|invalid.*key/i.test(raw))
    return "模型连接认证失败，请检查 API Key 后重试。";
  if (/\b429\b|rate.limit/i.test(raw)) return "模型服务暂时限流，请稍后重试。";
  if (/Failed to fetch|NetworkError|fetch failed|ECONNREFUSED/i.test(raw))
    return "连接已中断，草稿已保留；恢复连接后可以重试。";
  if (/API 未配置/.test(raw)) return "请先配置模型连接，再发送消息。";
  if (/\b(408|504|524)\b|timed?\s*out|ETIMEDOUT/i.test(raw))
    return "模型服务响应超时，已有内容已保留，可以重试。";
  if (/\b50[023]\b/.test(raw)) return "模型服务暂时不可用，请稍后重试。";
  if (/must be a string without null bytes|Received |Main process exited/.test(raw))
    return "本次运行未能完成，内容已保留，可以重试。";
  return raw.length > 300 ? "请求未能完成，原因尚未确定。" : raw;
}

/** Known local replay rejections remain actionable without exposing request data. */
export function retryScopeErrorMessage(error) {
  const raw = typeof error === "string" ? error : error?.message || "";
  if (raw.includes("原请求的工作目录或应用资源归属已改变"))
    return "工作目录或应用绑定已改变，请恢复原目录和绑定后重试。原请求、历史和草稿已保留。";
  if (raw.includes("原请求缺少执行归属记录"))
    return "原请求缺少资源归属信息，无法安全重试。历史和草稿已保留，请主动发送新消息。";
}
