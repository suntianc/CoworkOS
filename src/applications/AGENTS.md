# 应用与资源

新增应用从 `types.ts`、`registry.ts`、`builtins.ts` 和 `adapters/` 开始。应用、窗口实例、资源、Tab、Task 引用分别有自己的存储与身份；软件引擎在 `../software/`，屏幕操作在 `../gui/`。

- 编辑必须通过 ApplicationService/Adapter 的 revision 比较与提交；不从 HTTP 路由或前端直接改资源文件。冲突保留用户草稿。
- 原始外部文件、应用工程、产出物是不同的保存目标。覆盖原文件需沿用已验证路径和保存协议，关闭 Tab 不等于删除文档。
- 新 Adapter 定义读取、编辑、撤销、保存、历史与错误语义，更新工具能力、注册、前端会话与测试；不要只增加一个按钮。
- MCP 子进程属于应用窗口/宿主服务，跨单次 Run 存活；关闭服务和窗口时清理。MCP 本地认证辅助在 `mcp/local-api-client.ts`。
- 本层不依赖 Dashboard 或 CLI；需要宿主动作时使用接口和回调。
- 文本按 UTF-8 保存；通用二进制资源按原格式处理，不把二进制内容转成字符串。

接口见 [软件接入](../../docs/software-integration.md) 与 [工作区布局](../../docs/task-workspace-layout.md)。回归服务、Adapter、API 与对应 `e2e/` 编辑/保存/重开场景；具体映射见 [代码地图](../../docs/code-map.md)。
