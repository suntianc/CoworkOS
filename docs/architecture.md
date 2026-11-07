# 当前架构与开发边界

[English](en/architecture.md) | 中文

CoworkOS 是本机单用户 harness，CLI、Web 和 Electron App 共用运行时与应用服务。修改入口与测试见 [代码地图](code-map.md)，环境与命令见 [开发指南](development.md)，数据归属见 [工作区与持久化](task-workspace-layout.md)。

## 装配与依赖方向

```text
scripts/atria.mjs ─→ src/cli/ ─→ runtime / tools / workspace
desktop/ ─→ src/cli/dashboard.ts ─→ src/dashboard/
web/ ───── HTTP/SSE ─────────────→ src/dashboard/
                                  ├→ runtime / ProcessHost
                                  ├→ applications ─→ software
                                  ├→ gui ─→ security / 原生驱动
                                  └→ workspace / storage / domain
Pi 启动器 ─→ .pi/extensions/ ─→ .pi/runtime/ ─→ runtime / applications / tools
```

运行时的子智能体也可以使用应用、工具和工作区。共享服务不导入可执行 CLI；`runtime/` 和 `applications/` 不导入 Dashboard。GUI 不导入 HTTP、应用文档协议或 CLI。ESLint 和 [架构回归](../test/architecture-boundaries.test.js) 约束这些方向。

| 层                           | 负责的状态与行为                                                    | 入口                                                                                                                                                          | 边界                                                         |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| CLI                          | 参数、诊断、启动与信号                                              | [启动器](../scripts/atria.mjs)、[CLI](../src/cli/cowork.ts)、[Dashboard 入口](../src/cli/dashboard.ts)                                                        | 可执行入口，不承载 HTTP/MCP 共享实现                         |
| 页面装配/控制器              | 当前导航、展示、草稿、SSE、Tab 与用户交互                           | [app](../web/app.js)、[controllers](../web/assets/controllers/)、[workbench](../web/assets/workbench/)                                                        | 服务决定资源修订、Task/Run 结果；UI 保留异步请求归属         |
| Dashboard                    | 本机服务装配、HTTP/SSE、会话运行的进程所有权                        | [application](../src/dashboard/application.ts)、[routes](../src/dashboard/routes.ts)、[Run](../src/dashboard/run-service.ts)                                  | 路由校验和映射；Run 不写 HTTP 响应；路由不创建进程           |
| Runtime                      | Pi 会话、委派、Inbox、checkpoint、恢复、完成判定                    | [Coordinator](../src/runtime/coordinator-runtime.ts)、[RunService](../src/runtime/run-service.ts)、[PiSession](../src/runtime/pi-session.ts)                  | 不知道 HTTP/DOM；完成判定覆盖未结束委派、jobs、问答与消息    |
| ProcessHost                  | 子进程组、重复启动保护、任务停止、限时关闭                          | [ProcessHost](../src/runtime/process-host.ts)                                                                                                                 | 不裁决对话或资源业务状态                                     |
| Pi 接入                      | Pi hook、工具注册、应用上下文装配                                   | [薄入口](../.pi/extensions/cowork.ts)、[runtime](../.pi/runtime/extension.ts)、[应用桥](../.pi/runtime/application-bridge.ts)、[tools](../.pi/runtime/tools/) | 新领域工具进入对应模块；Pi 上游源码不在此修改                |
| Applications                 | 注册表、应用实例、共享资源、绑定、revision/CAS、历史、外部文件、MCP | [服务](../src/applications/application-service.ts)、[合同](../src/applications/types.ts)、[Adapters](../src/applications/adapters/)                           | 所有调用方共享操作语义；不处理屏幕输入                       |
| Software                     | 通用软件、异步驱动、二进制/工程资源                                 | [合同](../src/software/contracts.ts)、[服务](../src/software/software-service.ts)、[注册表](../src/software/provider-registry.ts)                             | 不能原地改变 v1 文件语义；取消、候选提交、失败恢复由驱动实现 |
| GUI / Security               | 窗口授权、观察/动作、串行队列、取消、审计、执行权限                 | [ComputerUse](../src/gui/computer-use.ts)、[权限](../src/security/execution-permissions.ts)                                                                   | 授权由可信宿主授予；文档 CAS 与模型决策不在此层              |
| Workspace / Storage / Domain | Task/Run 数据、输入/产出物、索引、持久事件、trace、文件锁与类型     | [工作区](../src/workspace/)、[存储](../src/storage/)、[领域](../src/domain/)                                                                                  | 格式兼容、路径归属与迁移显式维护                             |
| Desktop                      | 原生窗口、可信 IPC、加密模型设置、用户数据目录、退出保存            | [main](../desktop/main.cjs)、[preload](../desktop/preload.cjs)、[backend](../desktop/backend.cjs)                                                             | renderer 无 Node 权限；产出物查看窗口无可信桥                |

`createDashboardApplication()` 的导入不会监听端口或注册信号。启动与关闭信号在 `src/cli/dashboard.ts`；应用 MCP 客户端在 `src/applications/mcp/local-api-client.ts`。可复用服务必须能由测试显式装配和停止。

## Task、Run 和进程生命周期

浏览器请求 → HTTP 路由 → Dashboard Run → ProcessHost → Pi 启动器 → Pi 扩展 → Coordinator/应用服务。CLI 可以直接使用运行时服务；两种入口不各写一套业务状态机。

Dashboard Run 管理 Main 子进程和同 Task 的启动/停止串行化；运行时 RunService 管理实际 Pi 会话的 Task/Run、事件与 checkpoint。状态和输出落盘后才宣布完成；不能以最后一条文本代替完成判定。

桌面退出先经可信 IPC 等待渲染进程完成草稿/文档保存检查，有未保存的文档或任务草稿时提示用户返回处理或确认退出。桌面是独立后端的客户端：保存完成后它只结束自己的窗口与宿主能力，后端和已接受的 Run 继续执行，下次打开连接同一实例并读取同一任务。只有用户显式更换设置或安装更新时桌面才停止后端，随后重新连接。保存失败要保留窗口/草稿，不能强行关掉再依赖恢复。

当前桌面模型和联网搜索设置仍经启动环境传入默认执行主机；选中其他后端时桌面设置拒绝读取和修改，并显示其归属。保存默认后端设置会停止并重启该主机。后续桌面设置工作需迁移到执行主机的设置接口，并明确运行中任务的处理方式。

Pi 的 `before_agent_start` 在首轮请求前发现绑定应用与工具，`context` 在后续请求间刷新资源变化。回归必须覆盖真实 Pi hook 顺序和子进程结束，不能只用测试双证明生命周期。

视觉观察共用 Task 图片归档。原生 ComputerUse 由 Dashboard/桌面宿主管理全局授权、独占会话和当前观察凭据；Browser Use 由 Main/Pi 持有自己的临时 Chromium context。

QuickJS 保存当前 Pi 会话的脚本 state，经受限 dispatcher 逐次调用已启用的原生/浏览器工具，原工具继续负责权限、参数及 Task 归属。切会话/shutdown 清空 VM 并关闭浏览器，图片和已接受下载留在 Task；持久工具选择只恢复可用组。应用专属操作继续由既有 Adapter 提供。接口和边界见 [视觉观察](visual-observation.md)、[Browser Use](browser-use.md) 与 [CUA 脚本](cua-scripting.md)。

Main/Watch Supervisor、持久 Inbox、长期目标和显式 Virtual Agent 激活已存在。目标保存计划、事实、等待条件和汇报偏好，一个目标可关联多个 Watcher；普通回复结束不等于目标完成。应用内动态、未读和定期汇总已接入，更多真实来源、系统通知和连续运行评测仍待独立验收。

## 长期目标、监控与暂停

`WatchProgram.goal` 是目标的持久归属，不另建第二份任务注册表。`GoalStore` 管理版本与锁；`GoalManagement` 供 Pi 工具与 HTTP 共用；`GoalSupervisor` 修复持久化副作用、投递用户指令与到期复盘，不代替 Main 制定计划。目标状态、来源采样、模型运行和通知分别保存；目标上下文有界，完整动态不自动进入模型上下文。详见 [目标架构](long-term-goals-architecture.md)。

`WatchManagement` 共用来源登记和控制。`ScriptWatcher` 在可终止子进程中执行探针，原子提交 state/outbox checkpoint；`WatcherRuntime` 确认持久 Inbox 接受事件后清理 outbox。`WatchSupervisor` 分开调度采样、分析、重试与唤醒，慢分析不持有采样锁。Dashboard 的 `watch-service` 覆盖已登记工作区，经现有 Run 服务启动 Main；独立 CLI 保留监督入口，Task 周期锁协调多个启动者。

后台目标有自己的 Task/Main；会话内目标使用当前 Main。目标、来源与调度服务健康分别展示，不能仅凭 active 推断正在检查。退出宿主或机器休眠时停止采样；再次启动从持久状态恢复。macOS 源码入口可显式安装用户级 launchd 服务，不自动安装 OS 服务，详见 [运行时参考](runtime-reference.md#长期目标接口与调度)。

暂停是持久控制意图。后台目标完全暂停时，保存的时钟、旧回调、回答和重试仍保留，但不能自动启动 Main 或创建替代来源；恢复必须来自用户。会话内暂停只限制相关目标，不阻断无关工作。来源验收与暂停共用短锁，并在探针结束后复查意图；旧记录中所有来源已暂停的情况同样生效。详见 [暂停契约](monitoring-pause-contract.md)。

## 资源与界面的一致性

资源属于应用空间，对话只保存引用；多个对话可共享同一文档。应用资源根与 Task 存储根独立：项目中的资源服务可以管理用户数据目录中 Task 的引用、清单与实例加载关系，不能假定 Task 位于资源根之下。新独立应用的 holding Task 同样写入默认真实 Task 存储，旧项目 holding Task 保留原位。绑定后，应用服务缓存同时区分资源根与 Task 存储根。

HTTP、Run 与 Pi 通过 [Task 应用解析](../src/applications/task-service.ts) 从同一 Task 的持久绑定恢复活动资源根，不按当前项目目录迁移旧绑定；分离路径不迁移或删除旧数据，备份覆盖两根及外部原文件。

应用操作使用 revision CAS，冲突保留人工草稿。MCP 进程归应用窗口/本地服务所有，生命周期跨越单次 Run；资源变动使用现有 Run SSE，无 Run 时工作台轮询刷新。

v1 使用同步 UTF-8 文本文件协议，二进制资源保留不可变快照清单。内置应用目录为空，候选由已注册 Adapter 在锁外生成，校验与清单 CAS 在锁内提交。通用多文件事务、远程驱动和所有 v2 UI/历史能力仍未完整实现。

工作台轮询只清理读取快照中确认失效的标签，不删除期间创建或换身份的标签。空窗口创建文档时 `window:<instanceId>` 原位变成 `resource:<resourceId>`。显式导航捕获 Task/草稿身份和导航 token；每个异步步骤检查归属，晚返回可以完成后台工作但不能覆盖新的导航。

Composer Session 按会话保存草稿与已验证附件，发送捕获原 Task、草稿 token、模型及完整附件。刷新、切换、补充回退、附件读取和语音都保持原会话归属。流式更新复用变化的 DOM，保留焦点、选区、阅读位置和展开状态。

桌面后端端口随机；草稿不能只依赖 origin 的 localStorage。可信 preload 在页面启动前恢复私有 `composer-drafts.json`，只镜像允许的草稿键。保存经过格式/大小验证、原子写入和损坏备份；Web 仍按 origin 保存。资源审阅只读取快照，撤销是新 revision，不能绕过 CAS。

## 信任边界与支持范围

- 本机开发模式可无 token，Host/Origin 检查仍启用。桌面使用随机端口，从随包资源加载主页面；宿主核验所选本机后端的实例身份并交换短期会话，业务请求使用共用 HTTP 协议。
- 原生 IPC 只接受主窗口主 frame。密钥不进入 renderer 状态、源码和安装包；桌面加密设置与普通 Web/CLI 配置的存储方式分别记录在运行指南。
- Computer Use 在设置中提供屏幕录制、辅助功能和窗口访问三个按钮；系统权限分别申请，窗口访问仅在两项权限齐全且本机身份确认后可开启，允许所有对话观察和操作全部可见应用窗口。审批凭据由后端生成，只在后端和桌面内存保存 30 分钟；业务会话和 Agent 只能消费策略或撤销会话。

  策略与 Task/单窗口临时会话分离；旧仅观察策略恢复时关闭并保留原文件，不自动扩权。

  任务持有观察与连续动作的独占控制权，其他任务按先后等待；全局会话自动续期，旧手动会话仍限五分钟。暂停必须显式恢复；取消、导航/崩溃、服务停止和工作区切换撤销临时会话。后端重启后保存的期望策略须经本机确认才能重新开启。

- macOS 14+ 截图、解锁桌面输入、真实视觉模型、商业 App、干净机器权限分别验收。权限不足/锁屏导致的跳过不是原生输入通过。
- `GrantedPermissions` 覆盖软件 v2/GUI 宿主授权，不证明 Pi bash/jobs 全部受 OS 沙箱隔离。统一执行隔离需要单独实现和验证。
- App 的目标平台为 Apple Silicon Mac；Windows/Linux GUI 驱动、远程 Worker、多用户隔离和无人值守更新尚未交付。

修改接口时同步生产者和消费者、兼容/恢复文档与行为测试。主责角色见 [所有权表](module-ownership.md)，PR 规则见 [CONTRIBUTING](../CONTRIBUTING.md)，公开发布门槛见 [贡献约定](../CONTRIBUTING.md#pr审阅与发布) 和 [Mac 发布指南](mac-release.md)。
