# CoworkOS 终端界面适配

中文 | [English](en/cli-ui-adapter.md)

CoworkOS 使用 `@earendil-works/pi-coding-agent@1.5.2`，保留原始依赖、许可和恢复格式。产品名称不代表模型训练来源。原始请求归档、JSONL、SDK RPC 和用户指定的提示词继续记录实际内容；产品会话导出仅在副本中投影已知默认身份。

公开 `coworkos --version/-v`、`coworkos start --version/-v` 和 `npm start -- --version` 返回 CoworkOS 产品版本，无需配置、SDK、已编译 runtime 或可写用户目录。根版本查询不接受额外参数；start 同时含 help/version 时显示 help，其他执行参数与独立 version 混用会报错。选项值及 `--` 后正文不被当成查询。普通运行的扩展参数仍交 SDK 验证。

终端 overlay 使用独立版本与策略内容 hash，不覆盖旧缓存；完整性损坏时保留原文件并拒绝。产品启动不自动播放上游更新日志，`/changelog` 和 `coworkos update --check` 提供 CoworkOS 更新入口。SDK 原始 CHANGELOG 与技术资料保留。

## 六处受限 UI 差异

SDK 没有覆盖这些固定提示的公开 UI hook。CoworkOS 保留 SDK bundle CLI 入口，在交互子进程的模块加载中仅对一个经过审核的 chunk 做以下差异：

| SDK 方法                                    | 产品行为                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| renderProjectTrustWarningIfNeeded           | 重启指引为 atria；trust 判定、.pi 资源和授权行为不变。                     |
| checkTmuxKeyboardSetup                      | 使用 CoworkOS 名称；tmux 查询、超时和键盘设置建议不变。                    |
| suggestBugReport                            | CoworkOS 命令启用时可用 `/coworkos-bug` 保存本地反馈，用户检查后手动提交。 |
| crashReportInstructions                     | 正确的 CoworkOS 启动/恢复指引，反馈命令明确以 CoworkOS 命令启用为条件。    |
| run 的 takeUnnotifiedCrash 提示             | 保留时间、错误和通知消费，不承诺自动附件。                                 |
| setupEditorSubmitHandler 的精确隐藏命令分支 | `/dementedelves` 显示本地不支持提示；保留清空/return，其他输入原样处理。   |

固定策略在 [cli-ui-policy.json](../scripts/cli-ui-policy.json)，构建由 [build-cli-ui](../scripts/build-cli-ui.mjs) 校验实际 SDK 版本、三个入口文件 hash、类/方法和唯一 AST 位置，生成 `dist/cli-ui-manifest.json`。完整 span 清单的摘要同时锁定原文、位置和经审阅的替换内容；构建和运行均核对，构建还解析替换后的完整 JavaScript。span 使用 JavaScript UTF-16 索引，hash 使用原始 UTF-8 字节。运行包不需要 TypeScript。

[兼容层](../scripts/cli-ui-compatibility.mjs) 在父进程准备 profile/会话/Task/项目执行租约/后台进程之前只读校验；[boot](../scripts/cli-ui-boot.mjs) 在首次 SDK import 前重验，并在目标模块 load 时核对实际 source。失败显示 CoworkOS 错误，保留既有会话，不猜测替换或静默使用未适配的终端。新的 TUI supervisor 只在子进程通过校验、发出本次启动的就绪 IPC 后启动。[CLI 子进程宿主](../scripts/cli-runtime-host.mjs) 校验一次性 token，启动器等待子进程关闭后释放项目执行租约；token 在 SDK 导入前从环境删除，不传给工具子进程。

其他模块交 nextLoad 原样处理；无 stdout 过滤、原型修改或 node_modules 写入。hook 不通过 NODE_OPTIONS 或预加载参数传播到 worker、工具或用户程序。Node >=22.19.0 必需；[同步模块 hook](https://nodejs.org/download/release/v22.19.0/docs/api/module.html#moduleregisterhooksoptions) 仍属 Active development，升级 Node/SDK 必须复验，不能视为稳定 SDK 扩展 API。

默认 CoworkOS 命令扩展将 `/bug` 和 `/coworkos-bug` 映射到本地反馈文件，提交由用户手动完成。显式 `--extension` 可以替代默认扩展；此时 `/bug` 由所选扩展或 SDK 处理。通用错误和崩溃提示只在 CoworkOS 命令启用的条件下推荐 `/coworkos-bug`，不替其他反馈命令承诺本地保存或提交行为。

## 命令执行身份与完整输出

CLI 的交互、print、JSON 和 RPC 使用独立的 [命令策略](../scripts/cli-shell-policy.json)，仅处理 SDK 1.5.2 中的三个唯一位置：启动时设置 `AI_AGENT=coworkos`；模型原生 bash 工具和手动 `!`/RPC bash 的长输出文件使用 `atria-bash-*.log`。这是实际创建的文件名，工具正文及流式/最终 `fullOutputPath` 都引用同一个可读文件。`PI_CODING_AGENT=true` 保留为真实引擎的兼容标记；历史日志、正文及已保存路径不重命名。

[只读校验](../scripts/cli-shell-compatibility.mjs) 固定两个原始 bundle 文件 hash，要求每个原文唯一命中。父进程在准备用户状态前校验，子进程在导入 SDK 前重验，加载时再次核对原始 source。交互 boot 将三处差异与六处 UI span 合并，对同一原文排序并拒绝重叠；print/JSON/RPC 经 [普通 boot 入口](../scripts/cli-shell-boot.mjs) 加载原来的 SDK executable，不添加可继承的预加载参数或 stdout 标题。这些差异不依赖默认扩展，显式替换 `--extension` 仍生效；协议字段、命令退出码和取消行为保持原义。构建校验替换后的 JavaScript，许可与依赖文件原样保留。

## 升级与验收

启动器保持升级前的 terminal 默认与能力边界：交互 TUI 默认使用 regular 滚动区（用户可用 `--tui-mode fullscreen` 选择全屏），并关闭 Pi 1.x 内置的 MCP 客户端，工具表不因用户 `mcp.json` 增加 `mcp__*` 工具。

SDK 升级不得自动刷新支持 hash。维护者须审阅实际源码、六处 UI 和三处命令差异，更新策略，再验证唯一命中、拒绝、最低 Node/当前 Node、regular/fullscreen、自定义 editor、慢启动、reload、trust/tmux/错误/crash、命令长输出/失败/取消、停止/恢复和候选真实安装；适用的 Electron 路径也要验证。保留第三方许可原文，关联 [许可证说明](../THIRD_PARTY_NOTICES.md)。

回归入口为 [版本](../test/cli-information.test.js)、[资源](../test/cli-branding.test.js)、[构建/拒绝](../test/cli-ui-compatibility.test.js)、[真实 PTY](../test/cli-ui-pty.test.js)、[原生命令/RPC 输出](../test/cli-shell-identity.test.js)、[worker 隔离](../test/cli-runtime-host.test.js) 和 [身份/导出](../test/agent-identity.test.js)。实际 tmux 与 shim、注入异常与自然崩溃、确定性假模型与外部模型分别记录，不以全文 Pi 零命中作为验收。
