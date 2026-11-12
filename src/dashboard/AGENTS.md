# 本地服务

入口装配在 `application.ts`；端口、信号与 Electron 父进程消息由 `../cli/dashboard.ts` 安装。HTTP 辅助、产出行响应和 Main 环境都在本目录。

- `*routes.ts` 负责请求验证、服务调用与状态码，不能启动进程；Run 服务不依赖 HTTP 响应对象。这些规则由根 ESLint 检查。
- `run-service.ts` 负责启动、串行化、取消、恢复和完成判定，通过 `runtime/process-host.ts` 管理进程。完成/停止响应前必须完成必要落盘与进程回收。
- `http.ts` 负责 Host/Origin、会话认证和请求大小。新 API 不绕过入口检查；日志和错误不暴露配置原文。
- 修改 SSE 同时检查 `event-stream.ts`、前端 connection controller 与持久事件消费者；确保重连不重复交付。

定位与测试见 [代码地图](../../docs/code-map.md)，HTTP 说明见 [Product API](../../docs/product-api.md)。优先回归 `http-boundary`、`dashboard-run-service`、`main-run-env`、`artifact-api`，再按改动覆盖浏览器行为。
