# 文档维护约定

阅读入口见 [文档导航](README.md)。每个事实由一个主文档维护，其他文档通过链接引用。

## 事实归属

| 内容                         | 主文档                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| 产品能力、入口和支持范围     | 根 README                                                        |
| App / CLI 首次使用           | getting-started、cli-quickstart                                  |
| 更新、备份与安装排错         | installation-reference                                           |
| 模型设置                     | configuration                                                    |
| 配置字段、运行契约、组件命令 | configuration-reference、runtime-reference、components-reference |
| 应用与文件编辑               | applications、external-applications                              |
| 演示文稿使用与工具参数       | presentation-workflow、presentation-reference                    |
| 开发约束和功能定位           | 根/目录 AGENTS、code-map                                         |
| 依赖方向、状态与进程生命周期 | architecture                                                     |
| 环境、构建、启动和 UI 约定   | development                                                      |
| 本地验证、用例发现和跳过范围 | testing-local-run 及测试指南                                     |
| 委派、返修与验证证据交接     | development-handoffs                                             |
| 复盘落实状态与仍可触发的陷阱 | retrospectives、pitfalls/README                                  |
| HTTP/SSE、字段、错误和消费者 | product-api                                                      |
| 路径、revision、备份和恢复   | task-workspace-layout                                            |
| 应用/软件/GUI 接口           | software-integration 及领域指南                                  |
| PR 和审阅职责                | CONTRIBUTING、module-ownership                                   |
| 待开发工作与验收标准         | development-phases                                               |
| 打包、升级、签名和发布       | mac-release                                                      |

## 同步规则

- 模块/职责迁移同步代码地图、架构和目录 AGENTS，更新消费者及测试导入。
- HTTP、事件、工具、IPC、Adapter 变化同步现行接口；说明默认行为、版本兼容和失败恢复。
- 存储/revision/格式变化同步数据布局、备份、迁移和恢复步骤。
- 脚本、配置、依赖变化同步命令和支持范围；命令必须对应 package/scripts/help。
- 已交付行为写入使用或接口指南；未交付能力写入路线图，附入口和完成标准。
- 验证结果绑定版本/commit、环境、命令及结果，在 PR 或发行记录中给出；自动检查、原生、实际模型和人工验收分别记录。

## 双语入口

根 README 使用英文，中文版本为 `README.zh-CN.md`；CONTRIBUTING 和 AGENTS 的英文文件使用 `.en.md`，核心指南的英文版本位于 `docs/en/`。修改命令、字段、支持范围、依赖方向和验收条件时同步语言对。专项接口和阶段规划尚未翻译时，英文索引注明语言。

源码和本地文档使用真实 Markdown 相对链接。`npm run check:docs` 检查纳入范围的本地文件与标题锚点，不检查远程 URL 或产品行为。下载和 npm 安装命令必须指向实际可用的分发渠道。

## 文档范围

文档说明现行行为、兼容约定和维护计划。保留必要的限制和失败恢复信息；不提交个人环境、私有服务、用户任务、逐次操作记录或未经验证的验收结论。

新增文档登记导航。跨模块、持久格式、进程或权限决策应说明问题、负责模块、选择理由、兼容/迁移及测试要求；落实后更新相应主文档，避免多份互相冲突的约定。

## 文档站预览与静态构建

[文档首页](README.md)及现有 Markdown 同时用于 GitHub 阅读与独立 Docs 站点，不维护第二份正文。站点提供分类导航、页内目录、本地全文搜索、中英切换、代码复制和 Mermaid 图表；尚未翻译的指南标记为中文。

用户入口保留 App 与 CLI 安装和模型连接。侧栏默认折叠更多功能和开发者文档；搜索默认查找使用指南，勾选“全部文档”后搜索其余文档。

首页使用安装与模型设置卡片；快速开始使用编号步骤与下载文件组；模型设置使用可键盘操作的切换面板。正文仍在 Markdown 中维护，由 `docs/site/components.mjs` 增强，样式位于 `components.css`，无 JavaScript 时保留完整正文。

界面不重复正文标题或当前导航，不添加口号和区块说明。首页以入口与指南链接组织内容，次要动作使用图标并在悬停或键盘聚焦时显示提示。

在仓库根目录进入独立的站点工具目录后运行：

```sh
cd docs/site
npm ci
npm run preview
```

打开命令输出的本地地址。预览默认仅监听本机 `127.0.0.1:18743`，端口可用 `npm run preview -- --port=18744` 调整；修改文档后重新运行预览以生成新页面。README 的 Docs 徽章会进入文档首页。

```sh
npm run build
```

构建输出位于仓库根目录的 `.tmp/docs-site/`，可以作为静态目录托管；未执行远端部署。资源路径为相对路径，可部署到网站子目录。HTML、搜索索引与复制资源均为生成文件，不纳入源码。工具依赖在 `docs/site/` 独立安装，不进入产品运行时。

入口是 `scripts/docs-site.mjs`，导航在 `docs/site/navigation.mjs`，样式与浏览器交互在 `docs/site/`。新增主入口同时维护双语 Markdown 首页与侧栏导航；正文中的相对链接在构建时转换成静态页面链接，正文仍遵循上述维护规则。
