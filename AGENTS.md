# CoworkOS 开发入口

中文 | [English](AGENTS.en.md)

本文件供人和编码 Agent 使用。用户安装从 [README](README.zh-CN.md) 开始；产品内 Agent 的提示词和技能在 `.pi/`，与本仓库开发指引分开。

## 开始一项修改

1. 阅读 [代码地图](docs/code-map.md)，找到功能的实现层、消费者与测试；不要先向入口文件追加分支。
2. 阅读目标目录内的 `AGENTS.md`，跨目录修改时阅读两端指引。
3. 当前行为以代码、测试和 [架构](docs/architecture.md) 为准；按当前问题和验收范围选择工作。
4. 先复现问题，再修改负责该行为的模块。完成后运行相关行为测试和本地验证，报告实际执行命令、失败和跳过项。

## 仓库地图

| 目录                                            | 职责                                      | 约束入口                                  |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `src/cli/`、`scripts/atria.mjs`                 | 用户命令、启动器与 smoke 入口             | [代码地图](docs/code-map.md)              |
| `src/dashboard/`                                | 本地 HTTP/SSE、服务装配和 Run 编排        | [服务指引](src/dashboard/AGENTS.md)       |
| `src/runtime/`                                  | Task/Run、调度、恢复、模型与 Pi 会话      | [运行时指引](src/runtime/AGENTS.md)       |
| `src/applications/`                             | 应用注册、资源、修订、窗口、MCP、Adapter  | [应用指引](src/applications/AGENTS.md)    |
| `src/software/`、`src/gui/`、`src/security/`    | 软件驱动、原生交互、权限                  | [软件接入](docs/software-integration.md)  |
| `src/domain/`、`src/storage/`、`src/workspace/` | 领域类型、事件、工作区与产出物            | [数据布局](docs/task-workspace-layout.md) |
| `.pi/`                                          | 产品运行时的 Pi 装配、领域工具和技能      | [Pi 指引](.pi/AGENTS.md)                  |
| `web/`                                          | Web 与桌面共用的界面、控制器、编辑器      | [前端指引](web/AGENTS.md)                 |
| `desktop/`                                      | Electron 窗口、可信 IPC、本地后端生命周期 | [桌面指引](desktop/AGENTS.md)             |
| `test/`、`e2e/`                                 | Node 回归与浏览器/原生验收                | [测试指引](test/AGENTS.md)                |
| `docs/`                                         | 用户指南、开发约定和接口参考              | [文档指引](docs/AGENTS.md)                |
| `scripts/`、`.github/`                          | 构建、验证、打包、CI                      | [开发指南](docs/development.md)           |
| `vendor/`                                       | 第三方源码                                | 不作为产品业务代码存放位置                |

## 代码规则

- CLI 与桌面宿主使用同一套服务。共享业务模块不能导入 CLI 入口；运行时和应用层不能反向导入 Dashboard。ESLint 检查这些方向。
- 路由只校验、调用服务、映射响应；进程由 Run/ProcessHost 管理。导入服务模块不能启动端口、安装信号或发出模型请求。
- 按功能职责扩展现有服务、Adapter、控制器或 `.pi/runtime/tools/`。保持入口负责装配，避免把新能力集中到 `web/app.js`、Coordinator 或 Pi 扩展入口。
- TypeScript 使用 strict 和 ESM，本地 TS 导入保留 `.js` 后缀；桌面宿主保留 `.cjs`。外部 JSON、文件、工具参数、HTTP/IPC 在入口验证，错误必须可定位且不泄露密钥。
- 持久格式、事件、HTTP、Adapter、IPC 变更同时检查生产者和消费者。破坏兼容时写迁移和恢复策略；不原地改变旧格式字段含义。
- 不修改 Pi 的 `node_modules` 或生成文件来修产品问题；第三方改动要记录来源、版本和差异。
- 根目录保留公共入口、许可、示例配置与工具配置。维护中的技术文档放 `docs/`，构建与启动脚本放 `scripts/`；生成产物和本机绑定配置不作为源码提交。
- 只格式化本次修改。不要顺带重排旧文件、升级依赖或移动无关模块。
- UI: avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## 界面设计

避免不必要的次要标签、说明文字、辅助文案、描述性文字和冗余的微文案。让布局、视觉层级、间距和清晰的主操作自己完成解释。

- 优先用强视觉层级和自解释的结构，而不是用文字去解释。
- 默认不要添加 slogan 式文字、教学段落，或在每个区块下都加“帮助说明”。
- 如果确实需要补充信息，优先使用 info 图标 + tooltip，而不是始终显示的次要文字。
- 保留必要的表单标签和可访问名称，方便读屏软件；界面清爽不能牺牲可访问性。
- 危险或不可逆操作（删除、支付、提交永久性变更）必须保留清晰的后果提示。
- 去掉说明文字后，第一次使用的人仍应能看懂下一步点哪里、点了会发生什么。
- 重写已有界面时，先去掉冗余标签和说明；如果清晰度下降，再优化布局和按钮文案。

## 本地验证与交付

开发环境使用 Node >=22.19.0 和 `npm ci`。日常按修改范围验证：纯文档改动运行 `check:docs` 和 `format:check`；行为改动运行相关测试及轻量 `npm run verify`（CLI 与 Web 资源构建、源码卫生和静态检查）。发布验收或影响范围广的修改显式运行 `npm run verify:full`，完成完整构建、发布 runner 自测和全量确定性 Node 回归，不对每次小修改重复全量执行。`npm run test:unit -- --match model` 选择相关文件，`npm run check:docs` 检查文档链接，`npm run check:source` 检查当前源码是否混入私有配置、凭据、个人路径或生成/旧文档。完整命令和测试分层以 [本地测试指南](docs/testing-local-run.md) 为准。相关测试不能由模拟断言替代真实生命周期；浏览器、原生、真实模型与干净安装分别记录结果。

GitHub 的日常检查流程仅手动触发，不随 push/PR 自动运行；执行轻量静态检查 `npm run check:ci`。完整回归和发布验收在本地执行并记录证据。Mac 工作流仅手动触发，打包并上传到 Release 草稿，详见 [Mac 发布](docs/mac-release.md)。不要把 CI 通过当作完整测试通过，也不要默认添加浏览器、原生或跨平台测试矩阵。

提交说明包含：问题和结果、涉及模块/接口、执行的检查、尚未验证的范围。改变命令、功能、路径或接口，同一变更更新对应文档与代码地图；路线图只记录状态、下一步与验收标准。

`config.json`、`.cowork/`、`.tmp/`、`applications/`、`workspace/`、`task-*/`、supervisor 锁和用户数据都不是源码。不要读取真实密钥、删除运行数据、清理用户任务或把它们放进发布包。测试使用自己的临时目录与本地假模型服务。

第三方许可清单、分发渠道、签名/公证、干净机器安装和实际模型连接分别记录独立证据。正式/稳定版须完成对应 P0 门槛；限定范围的公开 beta 按贡献约定声明支持范围、ad-hoc/未公证的安装方式和待验收项，未完成的检查不能写成通过。本项目自有代码采用 MIT，第三方例外见 [许可证说明](THIRD_PARTY_NOTICES.md)。完整流程见 [贡献约定](CONTRIBUTING.md) 与 [Mac 发布](docs/mac-release.md)。
