# 当前架构与开发边界

[English](en/architecture.md) | 中文

CoworkOS 是本机单用户 harness，CLI、Web 和 Electron App 共用运行时。修改入口与测试见 [代码地图](code-map.md)，环境与命令见 [开发指南](development.md)，数据归属见 [工作区与持久化](task-workspace-layout.md)。

## 装配与依赖方向

```text
scripts/atria.mjs ─→ src/cli/ ─→ runtime / tools / workspace
desktop/ ─→ src/cli/dashboard.ts ─→ src/dashboard/
web/ ───── HTTP/SSE ─────────────→ src/dashboard/
                                  ├→ runtime / ProcessHost
                                  ├→ gui ─→ security / 原生驱动
                                  └→ workspace / storage / domain
Pi 启动器 ─→ .pi/extensions/ ─→ .pi/runtime/ ─→ runtime / tools
```

运行时的子智能体也可以使用工具和工作区。共享服务不导入可执行 CLI；`runtime/` 不导入 Dashboard。GUI 不导入 HTTP 或 CLI。ESLint 和 [架构回归](../test/architecture-boundaries.test.js) 约束这些方向。

| 层                           | 负责的状态与行为                                                | 入口                                                                                                                                                                                                    | 边界                                                      |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| CLI                          | 参数、诊断、启动与信号                                          | [启动器](../scripts/atria.mjs)、[CLI](../src/cli/cowork.ts)、[Dashboard 入口](../src/cli/dashboard.ts)                                                                                                  | 可执行入口，不承载 HTTP 共享实现                          |
| 页面装配/控制器              | 当前导航、展示、草稿、SSE 与用户交互                            | [app](../web/app.js)、[controllers](../web/assets/controllers/)、[UI](../web/assets/ui/)                                                                                                                | 服务决定 Task/Run 结果；UI 保留异步请求归属               |
| Dashboard                    | 本机服务装配、HTTP/SSE、会话运行的进程所有权                    | [application](../src/dashboard/application.ts)、[routes](../src/dashboard/routes.ts)、[Run](../src/dashboard/run-service.ts)                                                                            | 路由校验和映射；Run 不写 HTTP 响应；路由不创建进程        |
| Runtime                      | Pi 进程、委派、Inbox、恢复、完成判定                            | [Coordinator](../src/runtime/coordinator-runtime.ts)、[子代理后端](../src/dashboard/subagent-backend.ts)、[进程模型](../src/runtime/agent-process.ts)、[进程结算](../src/runtime/subagent-processes.ts) | 不知道 HTTP/DOM；完成判定覆盖未结束委派、jobs、问答与消息 |
| ProcessHost                  | 子进程组、重复启动保护、任务停止、限时关闭                      | [ProcessHost](../src/runtime/process-host.ts)                                                                                                                                                           | 不裁决对话业务状态                                        |
| Pi 接入                      | Pi hook、工具注册与上下文装配                                   | [薄入口](../.pi/extensions/cowork.ts)、[runtime](../.pi/runtime/extension.ts)、[tools](../.pi/runtime/tools/)                                                                                           | 新领域工具进入对应模块；Pi 上游源码不在此修改             |
| GUI / Security               | 窗口授权、观察/动作、串行队列、取消、审计、执行权限             | [ComputerUse](../src/gui/computer-use.ts)、[权限](../src/security/execution-permissions.ts)                                                                                                             | 授权由可信宿主授予；模型决策不在此层                      |
| Workspace / Storage / Domain | Task/Run 数据、输入/产出物、索引、持久事件、trace、文件锁与类型 | [工作区](../src/workspace/)、[存储](../src/storage/)、[领域](../src/domain/)                                                                                                                            | 格式兼容、路径归属与迁移显式维护                          |
| Desktop                      | 原生窗口、可信 IPC、加密客户端凭据、用户数据目录、退出保存      | [main](../desktop/main.cjs)、[preload](../desktop/preload.cjs)、[backend](../desktop/backend.cjs)                                                                                                       | renderer 无 Node 权限；产出物查看窗口无可信桥             |

`createDashboardApplication()` 的导入不会监听端口或注册信号。启动与关闭信号在 `src/cli/dashboard.ts`。可复用服务必须能由测试显式装配和停止。

项目台账与共享项目身份由 [项目数据服务](../src/workspace/project-data-service.ts) 持有：Dashboard 启动时按配置打开 SQLite 或 PostgreSQL 并执行版本化迁移，配置或连接失败会停止启动而不切换引擎。HTTP 路由、Main 工具与 `coworkos data backup/restore` 使用同一服务接口；SQL 方言、连接和事务在 [存储适配器](../src/storage/project-data/) 内封装，业务代码不按数据库分叉。Main 工具只经当前 Task 访问其项目，不能指定其他项目。需求看板是台账需求的独立投影：受控外部入口在同一事务里发布需求与看板条目，内部新需求只进台账；认领用条件更新产生唯一赢家，暂停保留归属，显式释放才回到待认领。同一服务还持有项目持久 Main 会话与运行归属；每个会话以本机一个 Task 作为历史容器，Pi 历史与执行目录留在实际执行后端，不进入共享记录。其他后端可通过 [认证远程客户端](../src/workspace/project-data-remote.ts) 访问同一权威服务，只登记自己的本机目录绑定，远端路径不进入执行目录。

## Pi 依赖边界

Pi 包的运行时导入（`@earendil-works/pi-*`，非 `import type`）只允许出现在持有 Pi 进程的区域：`.pi/`（扩展与工具）、`scripts/`（启动器）、模型配置、Main 会话文件读写与上下文压缩；其余模块只能用类型导入。允许区域是 [ESLint 规则](../eslint.config.mjs) 中的明确文件清单（`cowork/pi-import-boundary`），[依赖边界回归](../test/p46-pi-dependency-boundary.test.js) 校验清单与本节的路径一致。

- 模型配置（连接探测、思考档位、模型参数与请求记录）：[main-request-retry](../src/runtime/main-request-retry.ts)、[model-cache](../src/runtime/model-cache.ts)、[model-connection](../src/runtime/model-connection.ts)、[model-levels](../src/runtime/model-levels.ts)、[model-profile](../src/runtime/model-profile.ts)、[model-provider](../src/runtime/model-provider.ts)、[model-request-recording](../src/runtime/model-request-recording.ts)。
- Main 会话文件读写（后端在 Main 未运行时改写 Pi 会话文件，即会话消息编辑与分叉）：[conversation-fork](../src/runtime/conversation-fork.ts)、[main-message-edit](../src/runtime/main-message-edit.ts)。
- 上下文压缩：[compaction-summary-guard](../src/runtime/compaction-summary-guard.ts)、[compaction-summary-policy](../src/runtime/compaction-summary-policy.ts)。这是临时例外，压缩重新设计后收回，届时从规则清单删除。

包内深路径的运行时导入（如 `@earendil-works/pi-ai/api/...`）只允许出现在模型配置内：升级 Pi 时这些内部路径最容易失效。边界把一次 Pi 升级的排查范围收敛到清单内的模块，而不是全仓。

## Task、Run 和进程生命周期

浏览器请求 → HTTP 路由 → Dashboard Run → AgentProcessHost → Pi 启动器 → Pi 扩展 → Coordinator。CLI 可以直接使用运行时服务；两种入口不各写一套业务状态机。

Dashboard Run 管理 Main 进程和同 Task 的启动/停止串行化；运行时服务管理 Main 进程的 Task/Run、事件与恢复状态，会话与压缩由 Pi 自己保存。状态和输出落盘后才宣布完成；不能以最后一条文本代替完成判定。

Main 是常驻进程：一个 Run 由同一个 Pi 进程服务，一轮结束后进程不退出，后续用户消息与回调经它自己的持久 Inbox 送达并开始下一轮；进程按启动时记录的本机与启动时间标识，后端重启或更新后重新接管仍在运行的 Main，关闭会话（连同该会话在跑的子代理）、空闲超时与无法继续的模型请求才结束它。暂停在步骤边界停住且保留进程，取消只中断当前回合；空闲退出保留会话文件与任务状态，下一条消息或回调重新拉起同一会话。Main 进程是否在运行与是否有回合在进行是两件事，分别由后端记录与进程心跳报告。

派单也收敛到后端：Main 的 `call_subagent` 只向后端登记一个工作项，后端把登记写进该 Run 的持久队列、按依赖与租约启动独立的 Pi 进程，并把进程的结束写回队列、运行事件与 Main 的回调。每个工作区根只有一个属主启动与结算委派进程：Dashboard 运行时 CLI worker 不接管，属主重启后从持久记录接管仍在运行的子代理并补发停机期间结束的回调。子代理的会话、现场与结论都按工作项记录，返修在原 Executor 的 Pi 会话文件与现场里追加一轮；会话与工作区状态不随派单请求或进程内存丢失。

桌面退出先经可信 IPC 等待渲染进程完成草稿/文档保存检查，有未保存的文档或任务草稿时提示用户返回处理或确认退出。桌面是独立后端的客户端：保存完成后它只结束自己的窗口与宿主能力，后端和已接受的 Run 继续执行，下次打开连接同一实例并读取同一任务。安装更新时遵守更新停机门槛。保存失败要保留窗口/草稿。

桌面和 Web 的模型、联网搜索设置都通过所选执行主机的接口读写；运行中任务存在时后端拒绝变更。设置表单绑定后端实例，切换后须重新读取。客户端会话令牌由桌面宿主加密保存并注入受信主窗口请求；任务通知复用目录事件流并按后端与完成身份去重。

Pi 的 `before_agent_start` 在首轮请求前装配工具，`context` 在后续请求间刷新上下文。回归必须覆盖真实 Pi hook 顺序和子进程结束，不能只用测试双证明生命周期。

视觉观察共用 Task 图片归档。原生 ComputerUse 由 Dashboard/桌面宿主管理全局授权、独占会话和当前观察凭据；Browser Use 由 Main/Pi 持有自己的临时 Chromium context。

QuickJS 保存当前 Pi 会话的脚本 state，经受限 dispatcher 逐次调用已启用的原生/浏览器工具，原工具继续负责权限、参数及 Task 归属。切会话/shutdown 清空 VM 并关闭浏览器，图片和已接受下载留在 Task；持久工具选择只恢复可用组。接口和边界见 [视觉观察](visual-observation.md)、[Browser Use](browser-use.md) 与 [CUA 脚本](cua-scripting.md)。

持久 Inbox 是 Main 与子代理共用的送达方式：后端把回调、外部事件、追加消息、提问与同伴消息写入目标进程自己的 Inbox；进程内的扩展在每个安全回合边界重读整个 Inbox，空闲时由文件监听唤醒，不经标准输入、不轮询；监听事件可能迟到或被系统合并，因此送达不依赖它按时到达。`main.interrupt` 与 `main.resume` 也走这条通道，作为进程级命令被消费而不进入模型上下文。消息在进入进程的 Pi 会话上下文后才记为已消费，后端重启前后都能送达且每条只读一次。定时停泊和 Main 恢复沿用现有规则：有回调或定时唤醒时，Dashboard 运行服务按期检查并重新拉起没有存活 Main 的 Task；是否继续由 Main 决定。

## 会话与界面的一致性

Composer Session 按会话保存草稿与已验证附件，发送捕获原 Task、草稿 token、模型及完整附件。刷新、切换、补充回退和附件读取都保持原会话归属。流式更新复用变化的 DOM，保留焦点、选区、阅读位置和展开状态。

桌面后端端口随机；草稿不能只依赖 origin 的 localStorage。可信 preload 在页面启动前恢复私有 `composer-drafts.json`，只镜像允许的草稿键。保存经过格式/大小验证、原子写入和损坏备份；Web 仍按 origin 保存。

## 信任边界与支持范围

- 本机开发模式可无 token，Host/Origin 检查仍启用。桌面使用随机端口，从随包资源加载主页面；宿主核验所选本机后端的实例身份并交换短期会话，业务请求使用共用 HTTP 协议。
- 原生 IPC 只接受主窗口主 frame。密钥不进入 renderer 状态、源码和安装包；桌面加密设置与普通 Web/CLI 配置的存储方式分别记录在运行指南。
- Computer Use 在设置中提供屏幕录制、辅助功能和窗口访问三个按钮；系统权限分别申请，窗口访问仅在两项权限齐全且本机身份确认后可开启，允许所有对话观察和操作全部可见应用窗口。审批凭据由后端生成，只在后端和桌面内存保存 30 分钟；业务会话和 Agent 只能消费策略或撤销会话。

  策略与 Task/单窗口临时会话分离；旧仅观察策略恢复时关闭并保留原文件，不自动扩权。

  任务持有观察与连续动作的独占控制权，其他任务按先后等待；全局会话自动续期，旧手动会话仍限五分钟。暂停必须显式恢复；取消、导航/崩溃、服务停止和工作区切换撤销临时会话。后端重启后保存的期望策略须经本机确认才能重新开启。

- macOS 14+ 截图、解锁桌面输入、真实支持图片输入的模型、商业 App、干净机器权限分别验收。权限不足/锁屏导致的跳过不是原生输入通过。
- `GrantedPermissions` 覆盖 GUI 宿主授权，不证明 Pi bash/jobs 全部受 OS 沙箱隔离。统一执行隔离需要单独实现和验证。
- App 的目标平台为 Apple Silicon Mac；Windows/Linux GUI 驱动、远程 Worker、多用户隔离和无人值守更新尚未交付。

修改接口时同步生产者和消费者、兼容/恢复文档与行为测试。主责角色见 [所有权表](module-ownership.md)，PR 规则见 [CONTRIBUTING](../CONTRIBUTING.md)，公开发布门槛见 [贡献约定](../CONTRIBUTING.md#pr审阅与发布) 和 [Mac 发布指南](mac-release.md)。
