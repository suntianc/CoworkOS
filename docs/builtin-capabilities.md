# 能力范围与迁移

中文 | [English](en/builtin-capabilities.md)

这个分支保留 CoworkOS 的完整编排链路：Main、Coordinator Runtime、Subagent、Jobs、长期目标、监控、人工问答、工作区、记忆、检查点和会话恢复。通用文件与附件工具、图像读取、搜索、科学工具、Computer Use、通用 MCP 接口继续提供。

已移除的产品能力包括：

- 文本与 Markdown 编辑器、专用 MCP 服务、编辑工具、草稿会话组件及界面入口。
- Blender 工作台、引擎、安装器、Blender Harness，以及对应工具与技能。
- CAD 工作台、JSCAD/CadQuery 内核、CAD/FreeCAD Harness、原生查看器，以及对应工具与技能。
- PPTist、OfficeHarness、PPTX/HTML 演示文稿制作技能、`review_slides` 工具，以及对应编辑器与构建依赖。
- 上述组件的后台下载、组件管理界面、凭据 IPC、CLI 安装命令和独立组件打包发布流程。

通用附件读取继续支持提取已有 Office 文档内容。用户自行配置的外部 MCP 和自定义 skills 沿用原有发现机制。

## 已有数据

此次剪枝不执行用户数据迁移，也不删除已有项目文件、任务记录或下载的运行时。旧文本、CAD、Blender 和 PPT 应用资源在此分支中无法编辑；需要继续编辑时使用上游版本或原生应用，并保留原工程。启动新版本时建议使用独立的数据目录，避免旧应用 Tab 自动恢复干扰新工作区。

## 源码运行与验证

```sh
npm ci
npm run build
npm run ui
# 桌面开发入口
npm run desktop
# 全量确定性验证
npm run verify:full
```

安装器和构建不再下载或生成 CAD、Blender、PPTist 资源。发布记录保留其对应历史版本的事实；当前能力以本页和源码注册表为准。

内置应用目录现在为空。普通文本与 Markdown 文件由 Agent 的通用文件工具读写，用户可从任务产物中访问。原编辑器样本仅保留在 `test/fixtures/application-contract/` 用于通用协议回归，不进入发布包。
