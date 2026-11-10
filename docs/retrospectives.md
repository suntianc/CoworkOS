# 复盘落实与经验索引

2026-11-09 更新，合并 [P1](p1-retrospective.md)、[P2](p2-retrospective.md)、[科学工具剪枝](core-pruning-retrospective.md)、[P3](p3-retrospective.md) 和 [P4](p4-retrospective.md) 五轮复盘。每项经验归到现行指南、已有修复或待定事项；原验收记录继续保留。P4 修复已交付，两项操作坑点已记录，产品重构与工具建议保留待处理状态。

## 已落实的做法

日常操作入口为 [开发交接与验证记录](development-handoffs.md)，具体命令归 [本地测试](testing-local-run.md)。下表按问题合并跨轮重复建议。

| 经验                                                | 来源                                   | 当前落实位置                                                             |
| --------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| 保存完整输出，读取日志定位，按变化选择重验          | P1 §1、P2 §3、剪枝 §4、P3 §8、P4 §7    | 交接指南的输出、失败与复用；不为获取另一段输出重跑                       |
| 票据设计核对重复命令和次数，窄返修区分各阶段检查    | P1 §2、剪枝 §4                         | 派发与返修表及验证责任；保留冻结验收                                     |
| 逐项判定本次回归、基线、环境和未知失败              | P1 §4、P2 §3、P3 §7                    | 交接指南的失败分类及证据要求                                             |
| 准备依赖、生成资源、解释器后再开始候选检查          | P1 §4、P2 §4、剪枝 §3、P3 §1/§7        | 开发环境、交接环境字段及 [测试陷阱](pitfalls/README.md)                  |
| 共享接口核对远端消费者，剪枝同步 catalog 与双语入口 | P1 §3、P2 §5、剪枝 §1、P3 §2/§6、P4 §1 | 交接指南的消费者清单及现有代码地图                                       |
| 主代理接手系统认证和原生操作，按当前回执续跑        | P2 §1                                  | 原生操作交接、负责人及继续条件                                           |
| 包和原生证据绑定候选；保留 scratch 引用、失败与身份 | P2 §6、剪枝归档、P3/P4 归档            | 归档清单和证据复用规则                                                   |
| provider 替换交接实际环境、前轮发现与真实返修次数   | 剪枝 §3、§5                            | 替换执行者交接；工具改进单列于下                                         |
| 凭据存储和草稿恢复文档与实现一致                    | P2 后续事项                            | 中英文 [Mac 发布](mac-release.md)、[英文代码地图](en/code-map.md) 已同步 |

## 已修复并有回归覆盖

这些历史缺陷按现有实现和测试维护。需要修改对应行为时从代码地图进入，避免重复建立同一条坑点或验证框架。

| 历史问题                                                    | 当前覆盖入口                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 凭据迁移漏掉监控启动和会话脱敏                              | [主机设置](../test/os-backend-settings.test.js)、[监控启动](../test/watch-supervisor-launcher.test.js)                                                              |
| 全局下载拦截器误接管本地 Markdown 导出                      | [页面启动](../test/app-boot.test.js)、[会话菜单](../e2e/conversation-menu.spec.js)、[产物链接](../e2e/markdown-links.spec.js)                                       |
| 桌面/后端重复启动、后端接入与文件归属                       | [生命周期](../test/os-daemon-lifecycle.test.js)、[管理客户端](../test/os-web-client-protocol.test.js)、[Electron 草稿与文件](../test/electron-drafts-files.test.js) |
| 草稿恢复记录依赖存活租约、多组草稿缺少恢复入口              | [草稿与文件](../test/electron-drafts-files.test.js)、[恢复选择器](../e2e/electron-draft-recovery-picker-desktop.spec.js)                                            |
| 管理客户端、nonce、取消和草稿首次绑定组合缺口               | [组合回归](../test/merge-drafts-transport.test.js)、[Electron 组合](../e2e/electron-merge-combination-desktop.spec.js)                                              |
| Watch 普通命令继承错误权限上下文                            | [主机能力](../test/os-native-host-capabilities.test.js)                                                                                                             |
| 干净工作树的轻量验证缺少数学资源准备                        | [验证编排](../scripts/verify.mjs)、[仓库回归](../test/repository-checks.test.js)                                                                                    |
| 剪枝后 release catalog 与 runner 数量断言残留               | [发布计划](../scripts/release-test-plan.mjs)、[发布 runner 测试](../test/release/)                                                                                  |
| 不同 workspace 同名 Task 导致误删共享标签                   | [科学剪枝边界](../test/science-removal.test.js)                                                                                                                     |
| 台账工具注册过早要求运行凭据、PG 错误缺少定位               | [台账消费者](../test/p3-ledger-consumers.test.js)                                                                                                                   |
| 拒绝启动污染原 Run、需求归属丢失、retry/本地收尾状态错误    | [MainSession 消费者](../test/p3-main-session-consumers.test.js)                                                                                                     |
| 永久/暂时失败丢输入、重复请求清草稿、附件身份遗漏           | [容量生命周期](../test/p3-main-capacity-lifecycle.test.js)                                                                                                          |
| 重启恢复回收存活槽位、同请求重复启动                        | [容量生命周期](../test/p3-main-capacity-lifecycle.test.js)、[P3 恢复复盘](p3-retrospective.md#5-恢复回收必须复核锁内状态)                                           |
| 模型/容量设置读写与页面 origin 接线问题                     | [角色模型](../test/p3-role-models.test.js)、[容量](../test/p3-main-capacity.test.js)、[组合 UI](../test/p3-main-capacity-lifecycle.test.js)                         |
| 新增运行脚本遗漏 CLI/Electron 包清单                        | [CLI 打包](../test/cli-packaging.test.js)、[桌面依赖闭包](../test/desktop-runtime-packaging.test.js)                                                                |
| Python 显式环境被隔离 hook 清除、终态与 PTY 断言时序假设    | [输入文件](../test/input-files.test.js)、[CLI PTY](../test/cli-ui-pty.test.js)、[P3 归因](p3-retrospective.md#7-环境与时序失败逐项归因)                             |
| 权威与执行后端的 Git/现场归属混淆、完整 checkout 恢复失败   | [工作区](../test/p4-development-workspace.test.js)、[消费者](../test/p4-development-workspace-consumers.test.js)                                                    |
| 依赖等待前固定模型、恢复挂起、多个工作项共用现场            | [原生执行](../test/p4-native-execution.test.js)、[角色生命周期](../test/p4-native-role-lifecycle.test.js)                                                           |
| failed/drifted 发现无法裁定、来源覆盖、祖先结算和旧候选自检 | [候选审查](../test/p4-candidate-review.test.js)、[发现裁定](../test/p4-review-decisions.test.js)                                                                    |
| 合入回执不完整、恢复依赖读取触发、交付 diff 随 HEAD 改变    | [Git 恢复](../test/p4-integration-recovery.test.js)、[交付记录](../test/p4-delivery-records.test.js)、[消费者](../test/p4-delivery-consumers.test.js)               |
| 实际前台命令等待 stdin EOF                                  | [EOF 回归](../test/foreground-command-stdin.test.js)、[P4 修复及超时语义](p4-retrospective.md#6-stdin-eof-修复保留宿主生命周期管道)                                 |

## 仍需按触发条件查阅

[坑点索引](pitfalls/README.md) 按环境、命令和工具触发条件组织：依赖软链接、锁文件变化后的旧安装、Python 环境、Electron 运行时、格式检查范围、产品模型未配置、归档用户实例，以及 Workloop 正文交接/审查分类。已修复产品问题留在上表与原复盘，不再重复建立操作坑点。

## P3 新增建议的去向

| 建议                                           | 当前已有入口                                            | 状态                                 |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| 交接细化迁移归属、冻结前合并、原发现的失败类别 | [派发与返修](development-handoffs.md#派发与返修)        | 本轮已采用，后续落实已有规则         |
| 先校准 UI 路径/选择器，再进入正式组合验收      | [P3 §8](p3-retrospective.md#8-减少脚手架试错和重复准备) | 已记录，未增加流程或测试矩阵         |
| 同候选、依赖、环境复用准备与已接受证据         | [输出与复用](development-handoffs.md#输出失败与复用)    | 已有复用规则；通用前置回执支持待评估 |
| 用明确断言和退出码表达 probe 违例              | [WL-06](workloop-followups.md#wl-06-诊断脚本的失败表达) | 原记录保留，后续独立测试已补证       |

## 单列的 Workloop 建议

统一维护于 [Workloop 问题与建议](workloop-followups.md)：保留剪枝及 P3 的条目，合并 P4 再次出现的 Basis 解析和证据复用来源，新增最终 verdict 格式反馈、归档数据所有权、每轮报告身份与建议去重。确认的工具问题、证据质量问题和能力建议分别标记。

P4 的新增建议、文档落实与剩余状态见 [建议与去向](p4-retrospective.md#建议与去向)。跨运行审计提醒更新为 P4 收尾时的 9 个 run（上次检查为 2026-11-05）。本次整理未执行该审计，未修改 Workloop 源码、skills、状态或审计基线。

## 保留的阶段决定

P1、P2、科学剪枝、P3 和 P4 已交付归档。P2 干净 macOS 账户安装与系统权限验收保留到 P6；已接受的包、原生和性能记录继续使用。P4.5/P5/P6/P7/P8 未启动，下一步以 [阶段规划](development-phases.md) 为准。

各档案 `suggestions.md` 中包含重复与尚未验证的范围外观察。P3 的 67 条、P4 的 89 条也包含已修复项和元数据。这些原始记录保留，新的产品工作仍按具体目标与证据确定范围。
