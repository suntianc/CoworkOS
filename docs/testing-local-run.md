# 本地验证与发布验收

[English](en/testing-local-run.md) | 简体中文

按改动范围选择验证：纯文档修改只需 `npm run check:docs` 和 `npm run format:check`；行为修改运行相关测试及轻量 `npm run verify`。发布验收或影响范围广的修改使用 `npm run verify:full`。浏览器、原生窗口、真实模型和最终安装包分别验收。开发环境与 Python 附件依赖见 [开发指南](development.md)。

## 日常开发验证

```sh
npm ci
npm run verify

# 发布或广泛影响的修改：完整构建和全量回归
npm run verify:full

# 查看轻量/全量执行顺序，不构建或运行测试
npm run verify -- --list
npm run verify:full -- --list
```

`verify` 按顺序执行 `build:cli`、`build:web-assets`、`lint`、`check:workbench`、`check:extensions`、`format:check`、`check:docs` 和 `check:source`，不运行行为测试。`build:web-assets` 准备 KaTeX 和 Markdown 依赖；它不构建原生桌面资源。`verify:full`（等价于 `verify -- --full`）改用一次 `build:full`，静态检查后再运行 `test:release:runner` 和全量 Node 测试。两种模式均在第一次失败时停止，并保留原始退出码。轻量检查通过不代表相关行为或全量回归通过。

`format:check` 默认检查未提交变更。审查已提交差异时先用 `git rev-parse --verify '<基线>^{commit}'` 确认基线，再执行 `FORMAT_BASE=<基线> npm run format:check`，选择范围为 `<基线>...HEAD`；手动 CI 使用 `HEAD^`。默认命令在 clean 工作树可能输出 `No changed files to format`，见 [空选择陷阱](pitfalls/testing.md#提交后格式检查没有选中文件)。

`check:docs` 检查现行中英文文档和模块 AGENTS 的仓库内文件链接、Markdown 标题锚点，代码示例和外部 URL 不做请求。已移除的文档不再列为必需文件；删除文档时须更新引用，残留死链仍会失败。第三方许可链接指向版本固定的上游来源，发行包内许可另按实际产物检查。

`npm run check:source` 扫描当前已跟踪及非忽略的一方文本，拒绝私人路径、凭据形态、数字网关和私有/生成目录，不扫描 Git 历史。

`npm run check:docs -- --list` 查看文档门槛实际范围。新增现行指南时更新 `scripts/check-docs.mjs` 的清单；`docs/en/` 和模块 AGENTS 自动发现。

开发中先运行相关文件：

```sh
# 不依赖编译后运行时的纯脚本测试，无需产品构建
node --test test/repository-checks.test.js

# 只列出匹配文件，没有匹配会失败
npm run test:unit -- --list --match application-

# 自动完整构建后运行精确源文件，可重复 --file
npm run test:unit -- --file test/application-api.test.js
npm run test:unit -- --file test/p0.test.ts

# 已完成当前源码构建后，显式复用构建以加快迭代
npm run test:unit -- --skip-build --match conversation
npm run test:unit -- --skip-build --file test/application-resource-store.test.js --concurrency 1
```

`--match` 是区分大小写的文件路径子串，`--file` 是仓库相对的精确源测试路径，两者不能混用。拼错文件或匹配为空时，在构建前退出失败。

Node 测试自动发现 `test/` 下 `.test.js`、`.test.mjs`、`.test.ts`；TypeScript 用例执行其编译结果，p0/p1/p2 保持原脚本断言。发布 runner 在 `test/release/` 中单独运行，`verify:full` 包含其自测。新测试使用隔离夹具、临时目录和假的模型服务，避免修改真实工作区或调用真实模型。

默认 Node 回归明确列出并延后 `computer-native.test.js` 和桌面开发入口的可见窗口重启变体，通过已有发布清单统一控制；即使本机设置了原生测试环境变量，普通入口也关闭该变体。需要真实窗口操作时使用下面的 `--native`。

其他 Mac 平台用例仍按自身条件运行或在 TAP 中明确跳过；退出码 0 不代表跳过项已经验证。保存实际测试数和 skip 原因，不能把历史计数作为本次结果。

`npm test` 和 `npm run check` 继续保留，分别用于已有 Node 回归和静态门槛；两者连跑会重复构建，显式完整检查用 `verify:full`。

GitHub 常规检查仅手动触发，不随 push/PR 自动执行；手动运行轻量 `npm run check:ci`，只做 CLI 构建、lint、类型、增量格式、文档链接与源码卫生检查。完整 Node、浏览器、原生、实际模型与本页的发布 runner 在本地执行；轻量 CI 通过不代表这些行为已验收。触发范围见 [开发指南](development.md#github-actions)。

版本 tag / Release 工作流修改可先执行 `npm run test:unit -- --file test/release-metadata.test.js`。该用例使用临时 Git 仓库校验版本、tag、提交身份与 Actions 输出，不访问远端 Release；上传/草稿重试以实际 Actions 日志另行验收，流程见 [Mac 发布](mac-release.md#版本-tag-与-release-草稿)。

## 性能回归

先使用隔离数据检查读取次数、并发请求和 DOM 保留，再测耗时，避免把本机模型或原生计算负载误算为前端开销。已有当前构建时运行：

```sh
node --test test/workspace-directory-performance.test.js test/application-tab-read-cost.test.js test/resource-mapping-noop.test.js test/event-stream-ledger-performance.test.js test/event-stream-review-regressions.test.js test/visible-poll.test.js test/connection-controller.test.js
npx playwright test e2e/dashboard-polling.spec.js e2e/editor-visibility-polling.spec.js e2e/binding-menu.spec.js --workers=1 --output=.tmp/browser-performance
```

- 目录夹具含 57 个已归属会话：每次列表只读取各 Task 一次，项目索引按批次共享；下一请求必须看到重命名和新建。
- 应用夹具含 2 个目录、40 个窗口：每次修订检查只发现目录一次；已有 holding 引用不重复落盘，列表与修订读取均有文件读取预算。并发创建首个资源、外部修改、别名与事务恢复分别验证。
- SSE 空闲时不重复读取账本正文；首次连接只读取历史末尾，连接后一次追加 600 条必须全部交付（包括初始空/缺失账本），文件替换后继续同步。详情读取最近 30 条时，普通短记录只需一个 64 KiB 范围，覆盖短读、中文、emoji 和无末尾换行；连接关闭后不能继续写响应或读取其他日志正文。
- 浏览器检查慢请求不重叠、不丢草稿，无变化详情保留 DOM，折叠栏展开补画；多页面和编辑器隐藏时停止自动读取，恢复可见立即同步，SSE、主动加载、保存和自动保存仍保持正确。

计时对比须保持相同数据、打开窗口数、冷/热状态和运行负载，记录响应状态、大小与耗时，不打印用户正文或配置。测试使用自己的临时工作区和本地服务；原生启动及真实模型延迟需单独测量。

## 浏览器、原生与真实使用验证

```sh
npx playwright install chromium
npm run test:browser

# 已有当前构建时，直接挑选浏览器文件
npx playwright test e2e/automation-workspace.spec.js --output .tmp/browser-workbench

# Mac 原生窗口/输入需要已有权限和解锁桌面
npm run test:release -- --native --stage app,applications
```

浏览器入口会构建并运行 Playwright；原生变体的适用条件以测试和发布清单为准。并行本地浏览器进程使用独立 `--output` 目录。真实模型 smoke 会消耗模型服务资源，按 [模型配置](configuration.md) 显式配置后执行。最终包安装、升级、签名/公证和人工体验按 [发布指南](mac-release.md) 单独记录。

打包 App 使用 `npm run test:desktop` 验证文本、Pi/本地模型、保存恢复、退出/重启与搬移升级。已有当前候选时可用 `ATRIA_DESKTOP_APP=.tmp/release/mac-arm64/CoworkOS.app node scripts/desktop-smoke.mjs` 避免重复构建。

聚焦模型设置时可在已有候选包上运行 `ATRIA_DESKTOP_APP=.tmp/release/mac-arm64/CoworkOS.app node scripts/desktop-smoke.mjs --settings-only`。该入口验证首次保存、脱敏读取及任务运行时模型/搜索设置拒绝修改；其他桌面 smoke 阶段不执行。

开发入口重启、输入框与模型连接原生测试使用临时 App、独立数据目录和 Chromium 测试钥匙串，验证客户端凭据加密、密文兼容、草稿与原生进程生命周期，避免临时签名触发真实钥匙串授权。此隔离仅用于测试；产品继续使用系统钥匙串，实际授权、签名安装包和跨版本升级需要单独验收。

## 五环节发布验收入口

发布入口按五个环节运行已有确定性测试，保存日志和报告，不自动调用收费模型，不申请或扩大系统权限。具体场景见 [用例目录](testing-case-catalog.md) 和 [应用操作手册](testing-application-release.md)。

## 使用

在仓库根目录安装锁定依赖，并准备 Chromium。原生构建沿用现有 Mac 工具链。

```sh
npm ci
npx playwright install chromium
npm run test:release -- --list
npm run test:release
```

查看清单不会构建、启动测试或写报告。默认构建一次，然后依次执行基础、CLI、App、应用和已有用户链路。Node 测试与日常入口共用递归发现规则，包含 `test/` 下的 `.test.js`、`.test.mjs`、`.test.ts`，排除单独执行的 `test/release/`；TypeScript 用例执行对应编译结果，每个文件只执行一次。浏览器测试发现 `e2e/*.spec.js`，基础环节也运行 p0/p1/p2、静态检查和 runner 自测。

```sh
# 仅运行相关环节；仍默认重新构建
npm run test:release -- --stage cli
npm run test:release -- --stage app,applications

# Mac 上加入隔离的真实 Electron/窗口操作测试
npm run test:release -- --native

# 同时构建 CLI tgz 和 Mac DMG，随后按手册人工安装验收
npm run test:release -- --native --packages

# 仅调试已完成的构建；报告明确记录未重新构建
npm run test:release -- --stage cli --skip-build

# 发布入口自身的回归；verify:full 包含此步骤，普通 npm test/CI 不自动发现
npm run test:release:runner
```

`--native` 需要解锁的 Mac、现有系统权限和可见测试窗口。模型协议等 desktop 文件，以及模型配置文件中的 Electron 变体、开发入口的原生重启变体，都由此开关控制；默认仍保留同文件的 Web/协议测试。未选择的文件和变体在报告单列。某些领域 Node 测试在无引擎环境会自行跳过，报告保留实际 skip 数。`--packages` 只构建候选文件，不能代替最终包安装、升级、签名/公证或真实模型验收。

## 报告含义

每次执行保存到 `.tmp/release-tests/<时间与随机ID>/`：

| 文件                   | 内容                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| report.json            | 源 commit、dirty 状态与源文件摘要、平台/Node、执行选项、实际命令/测试文件、每步结果/统计、规划用例映射、待验项、候选包 hash |
| summary.md             | 工程结果、每步耗时/跳过、人工和未自动执行清单                                                                               |
| 每步 .log              | 本地 stdout/stderr，保留首次失败；分享前脱敏                                                                                |
| 浏览器步骤 .json       | Playwright 的实际用例结果，重试后通过仍标 flaky，不抹去首跑失败                                                             |
| 浏览器步骤 -artifacts/ | 独立的 Playwright 产物目录，保留失败 trace 和现场记录，后续环节或重跑不会清理旧报告                                         |

工程结果分为 passed、passed_with_skips、failed、interrupted、incomplete。执行失败、超时或测试没有生成有效统计会停止后续步骤，保留已完成日志。Ctrl-C 会中止当前进程组；单步默认 1800 秒，可用 `--timeout-seconds N` 调整。

默认退出码 0 表示已选工程步骤通过（可能存在明确记录的 skip）；1 表示失败/不完整；130 表示中断。`--strict` 在工程通过但发布证据不完整时返回 2。选一个环节通过不能代表整版通过。

发布验收目前始终显示 INCOMPLETE：新目录尚未逐项完成覆盖审阅，入口也不自动验证真实模型、最终包和人工体验。测试文件通过后只记为工程证据：已有映射仍为 partial_mapping，未映射仍为 planned，不会自动变成完整覆盖。按 summary 和软件手册另做人工记录后，由维护者 review 发布证据。

## 维护发布目录

`test/release/catalog.json` 保存五环节分类规则、现有用例锚点和人工清单。新增 Node/browser 文件会被发现：未匹配规则的 Node 文件归基础，browser 文件归 App；新增领域或用户任务时补分类规则。runner 自测确认每个文件只归一个环节、编译执行路径、ESM 失败传播和映射 ID/文件存在。

新功能先在主目录补用户动作和通过标准，再增加对应测试与锚点。测试计划、实际执行结果与人工确认分别维护。Computer Use 已实现同桌面宿主的全局策略与 Task 单窗口会话；真实 Pi/HTTP 使用隔离驱动与可控时钟覆盖续期，浏览器覆盖全局设置和接管。解锁桌面的原生输入、干净安装首次权限、真实 App 重启及签名升级的权限保留分别记录，不能由这些工程用例替代。

正常发版使用完整当前构建和最终文件。

源码在执行期间变化会记录并使原本通过的结果变为 incomplete；重新构建/执行后另留报告，不覆盖首次失败。

## 应用内更新专项

公开检查与发布边界见 `test/update-release-public.test.js` 和 `test/public-release-publish.test.js`；桌面状态、保存门槛与安装边界见 `test/desktop-updates.test.js`、`test/desktop-update-host.test.js`、`test/desktop-update-install.test.js`。普通 Node 回归不执行真实 App 替换。原生检查只操作自己的临时 App、DMG 与用户目录：

```sh
ATRIA_MANAGED_UPDATE_NATIVE=1 node --test test/desktop-update-install.test.js
ATRIA_PUBLIC_APP_UPDATES_SMOKE=1 ATRIA_DESKTOP_APP=.tmp/release/mac-arm64/CoworkOS.app npx playwright test e2e/public-app-updates-desktop.spec.js --workers=1 --output=.tmp/public-app-update-native
```

第二项仅在测试进程内把固定公开 URL 映射到本地 HTTP，仍执行真实下载、DMG/签名校验、退出、helper 替换、新进程回执和重开后的版本/草稿核对。它不证明真实公网连通性；发布后另以无凭据客户端核对真实静态清单、公开安装包和完整 SHA-256。另一台干净机器、Gatekeeper、Developer ID/公证与真实模型仍分别验收。
