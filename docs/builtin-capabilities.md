# 能力范围与迁移

中文 | [English](en/builtin-capabilities.md)

这个分支保留 CoworkOS 的完整编排链路：Main、Coordinator Runtime、Subagent、Jobs、人工问答、工作区与会话恢复。通用文件与附件工具、图像读取、搜索、Computer Use 继续提供。

已移除的产品能力包括：

- 用户记忆（含手动记忆）、自动学习与项目经验：存储、HTTP 接口、Pi 工具、界面入口与专门测试一并移除，项目上下文改由需求台账提供。
- 视觉模型：独立的图片分析连接角色（`modelConnections.visionId`、`COWORK_VISION_*` 环境变量、设置页的图片分析用途）以及把图片转交该模型分析的路径一并移除；读图只使用本身接受图片输入的当前连接。
- 长期目标与监控：长期目标、目标决策与委托、监控规则与定时唤醒，及其 Pi 工具、HTTP 接口、界面入口与专门测试；Main 的恢复职责改由运行服务的守护按期检查。
- 应用与工作台：应用注册、应用实例、共享资源与 revision 协议、应用绑定、Adapter、MCP 托管、文本与 Markdown 编辑器、工作台标签页及界面入口。
- Blender 工作台、引擎、安装器、Blender Harness，以及对应工具与技能。
- CAD 工作台、JSCAD/CadQuery 内核、CAD/FreeCAD Harness、原生查看器，以及对应工具与技能。
- PPTist、OfficeHarness、PPTX/HTML 演示文稿制作技能、`review_slides` 工具，以及对应编辑器与构建依赖。
- 科学工具、科学环境安装及专项 Office 创作技能。项目可使用自身的 Python 环境。
- 上述组件的后台下载、组件管理界面、凭据 IPC、CLI 安装命令和独立组件打包发布流程。

通用附件读取继续支持提取已有 Office 文档内容；自定义 skills 沿用原有发现机制。联网搜索仍通过内置的 Exa 服务提供。

## 已有数据

产品启动不会自动删除项目文件或任务记录。旧应用实例、资源和标签文件保留在磁盘但不再读取，旧文本、CAD、Blender 和 PPT 应用资源无法在界面中打开；需要继续编辑时使用上游版本或原生应用，并保留原工程。启动新版本时建议使用独立的数据目录。

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

安装器和构建不再下载或生成 CAD、Blender、PPTist 资源。发布记录保留其对应历史版本的事实；当前能力以本页和源码为准。

应用与工作台已在 P4.6 整体移除。普通文本与 Markdown 文件由 Agent 的通用文件工具读写；附件通过上传、`read_attachment` 和预览下载访问，产出物通过 `publish_artifact` 发布，并在工作入口中以只读预览、下载或桌面「用系统默认应用打开」使用。
