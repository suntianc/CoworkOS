import assert from "node:assert/strict";
import { test } from "node:test";
import { modelErrorDiagnostic, retryScopeErrorMessage } from "../web/assets/request-error.js";

test("model errors expose known categories, status and policy code without leaking response bodies", () => {
  for (const [status, category] of [
    [400, "请求被拒绝"],
    [401, "身份认证失败"],
    [403, "访问权限不足"],
    [404, "接口或模型不存在"],
    [429, "请求限流"],
    [500, "模型服务内部错误"],
    [502, "模型网关错误"],
    [503, "模型服务暂不可用"],
    [504, "模型网关超时"]
  ]) {
    assert.equal(modelErrorDiagnostic("private body", status), `${category} · HTTP ${status}`);
  }
  assert.equal(
    modelErrorDiagnostic('cowork-glm API error (400): {"code":"cyber_policy","message":"private body"}'),
    "内容安全策略拒绝 · HTTP 400 · cyber_policy"
  );
  assert.equal(
    modelErrorDiagnostic('HTTP 403: {"error":{"code":"content_filter"}}'),
    "内容安全策略拒绝 · HTTP 403 · content_filter"
  );
  assert.equal(modelErrorDiagnostic('provider-401 https://example.invalid/503 {"code":"secret-code"}'), "");
  assert.equal(modelErrorDiagnostic('malformed {"code":'), "");
  assert.equal(modelErrorDiagnostic("unknown", 999), "");
});

test("replay ownership rejection explains recovery without exposing paths or provider bodies", () => {
  assert.match(retryScopeErrorMessage(new Error("原请求的工作目录已改变 private-path")), /恢复原目录后重试/);
  assert.match(retryScopeErrorMessage("原请求缺少执行归属记录 private-data"), /主动发送新消息/);
  assert.equal(retryScopeErrorMessage("provider rejected private-data"), undefined);
  assert.equal(retryScopeErrorMessage("原请求的工作目录已改变 private-path").includes("private-path"), false);
});
