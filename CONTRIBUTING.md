# 贡献与开发约定

[English](CONTRIBUTING.en.md) | 中文

使用 Node >=22.19.0 和 `npm ci`。人和编码 Agent 从 [AGENTS](AGENTS.md)、[代码地图](docs/code-map.md) 开始，读取目标目录指引。源码使用 [MIT](LICENSE)；第三方来源和许可见 [声明](THIRD_PARTY_NOTICES.md)。

## 一项修改的完成标准

1. 明确触发场景、修改后的行为、负责模块及消费者；补上具体范围和验收标准。
2. 用隔离工作区复现，在负责该行为的服务/Adapter/控制器修复。新增工具放领域模块，入口只装配。
3. 添加有意义的行为回归，覆盖涉及的失败、取消、异步归属、冲突或恢复；沿 [代码地图](docs/code-map.md) 选择相关测试。
4. 按改动范围验证：纯文档运行链接/格式检查，行为修改运行相关测试和轻量 `npm run verify`。发布或广泛影响的修改运行 `npm run verify:full`；UI/原生/打包变化完成对应额外验收，记录失败与跳过。
5. 同步现行文档、代码地图，写出问题、结果、验证和限制。

```sh
npm run test:unit -- --file test/name.test.js
npm run verify
# UI / HTTP-UI 集成变化；首次先 npx playwright install chromium
npm run test:browser
# Mac 宿主、退出恢复或安装包变化：Apple Silicon Mac
npm run desktop:pack
npm run test:desktop
```

`verify` 负责普通本地工程门槛，原生、实际模型和发版五环节分开运行；详细范围见 [本地测试](docs/testing-local-run.md)。检查跳过不能作为该平台通过，实际模型请求不能由本地协议夹具替代。

## 代码与接口规则

- TypeScript strict、ESM、本地 TS 导入 `.js`；Electron 宿主使用 `.cjs`。外部 JSON、文件、HTTP/IPC、模型工具参数在入口验证，动态输入使用 unknown 并缩窄，不新增显式 any。
- 共享服务不导入 CLI；运行时/应用不导入 Dashboard。路由不启动进程，Run 不写 HTTP 响应；服务模块导入不打开端口或注册信号。依赖方向由 ESLint 和架构回归检查。
- 新行为通过现有接口扩展工具、Adapter、驱动、store 或控制器。拆分前明确状态、存储、进程、展示各自负责人；不要把行为重新集中到 Coordinator、Pi 入口或 `web/app.js`。
- HTTP/事件/Adapter/软件/IPC/持久格式变更同时更新生产者和消费者，写明兼容及恢复方式。可选字段需默认行为；改变旧字段含义、revision 或序列化格式时显式升版本并迁移。
- 迁移先备份，验证前版升级、失败保留旧数据、未来版本拒绝降级；成功后才更新版本记录。共享写入遵循 revision CAS，冲突保留草稿。
- 生命周期测试包含真实子进程或 Pi hook；断言用户可见结果、持久状态和故障恢复，不复制函数实现。
- 不修改 Pi 的 `node_modules` 或生成文件修产品。第三方改动注明上游版本、来源和本地差异，同步许可/声明。
- 仅格式化本次变更。`npm run format` 处理本地改动，`format:check` 与 CI 增量检查一致；避免无关大面积重排或依赖升级。

模型密钥、私有配置、用户工作区、trace、测试产物和发布包不提交；日志不打印密钥或配置原文。测试使用临时目录/本地假模型，不清理真实任务或资源。

## PR、审阅与发布

只保留 main 一条长期分支；feat/fix 临时分支从 main 分出，经 PR 回 main，合并后删除。main 代表通过评审的集成代码，用户版本由固定 tag 和 Release 标识。反馈、候选与发行流程见 [版本管理](docs/beta-release-process.md)。

一个 PR 完成一项职责明确的修改。使用 [PR 模板](.github/pull_request_template.md)，描述最终问题/结果、接口消费者、数据影响、实际验证及未覆盖范围；说明最终实现，省去讨论过程。模块审阅角色见 [所有权表](docs/module-ownership.md)；跨接口两端协同，真实人员未分配时维护者负责审核。角色表与工作流不代表 CODEOWNERS/分支保护已经启用。

完成本地 verify 后，根据变化增加浏览器、跨平台、原生或安装验收，并在 PR 中提供相应证据。GitHub 常规检查仅手动触发，运行轻量 `check:ci` 构建/静态检查，不随 push/PR 自动执行；Mac 工作流只上传 Release 草稿，维护者验收后再发布。本地行为回归要求保持不变，触发范围见 [开发指南](docs/development.md#github-actions)。

正式/稳定版在作出相应产品与平台承诺前，完成 以下 P0 门槛：许可/第三方内容、分发渠道、实际模型、Developer ID 签名/公证、干净机器安装和升级恢复。限定范围的公开 beta 单独说明支持范围、安装方式和未完成验收，不能把 beta 当作已经满足全部 P0 的稳定版。

公开 beta 仍须审查源码、第三方许可和包内容，绑定已审核 commit/tag，提供产物清单与 SHA-256。

首批 Mac beta 为 macOS 14+ Apple Silicon 的 ad-hoc 签名 DMG，无 Developer ID、未公证，首次安装使用 DMG 并按 Gatekeeper 提示批准启动；应用内更新可在用户可写目录中校验并替换 App，保留旧版备份，不绕过系统保护。无 Developer ID 时不生成签名 ZIP/feed。CLI 要求 Node >=22.19.0，按本版记录声明实际验收的平台，其他平台不能由可编译推断通过。

发行说明分别列出已完成的本地 verify、协议/浏览器回归、原生与安装包检查及其版本/环境证据，以及待验收项。真实模型连接和另一台无开发环境机器的安装/升级仍待独立验收；本地假模型、打包或最低系统版本设置不能替代这些结果。未执行、失败、跳过和旧候选结果均不能写成本版通过。

## 文档与双语

事实的主文档和同步范围见 [文档维护](docs/documentation.md)，阅读入口见 [文档导航](docs/README.md)。用户/开发关键入口提供中英文；修改命令、支持范围、边界和验收条件时同步语言对。专项接口目前主要为中文，英文导航须明确标注。
