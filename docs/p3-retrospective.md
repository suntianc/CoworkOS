# P3 复盘：项目共享数据与多 Main 基础

日期：2026-11-08。本文整理 P3 六张票的实现、交接、返修和验收，接续 [P2](p2-retrospective.md) 与 [科学剪枝](core-pruning-retrospective.md)。经验与现行指南的对应关系见 [复盘索引](retrospectives.md)，工具问题见 [Workloop 问题与建议](workloop-followups.md)。

## 交付与验证

交付分支 `workloop/os-p3-project-foundation`，提交 `11f0f42cb00c509d8e4cfe335b994392819bc3da`；六票、12 AC 完成独立审查、集成、终审及归档。范围包括默认 SQLite / 可选 PostgreSQL、共享需求台账与看板、项目 Main 会话、固定运行名额、角色模型配置基础及组合 UI。

执行使用 DSH headless / deepseek-v4.1-flash high，审查和终审使用 Devin swe-2-max。整轮有 12 次票据审查、1 次终审、1 次集成前置失败和 1 次已授权的额外返修；没有执行者替换、retry 或接管、审查豁免或最终 waiver。

| 验收           | 记录                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立终审       | 公共检查与 11 条验收命令；67 pass / 0 fail / 0 skip，12 份回执零漂移                                                                         |
| 全量确定性检查 | 2768 tests / 2765 pass / 0 fail / 3 native skip                                                                                              |
| 组合行为       | SQLite 与真实 PostgreSQL 的相同 HTTP/进程场景；Chromium 项目、台账、看板、会话、容量与模型设置流程                                           |
| 同包安装       | 同一 CLI tar 隔离安装，分别验证 SQLite/PG 持久化、重启、备份与恢复                                                                           |
| 证据复用       | 最终提交与候选 `e5e9e56795dcc3fd93ebbce4bed9ab5ce4bc433b` 同树 `cf1423d3a15f99eaaae46726e8039c6c8f91f254`；复用已接受的 full/package/UI 回执 |

最终 CLI 包大小为 39,298,827 bytes，SHA-256 为 `b613539d6cade4e680ec55aedf11877f99cf3c8a68f202612ee0a8b7dda1022f`，包内 build-info 保留 e5e9e567 身份。P2 原生与性能证据继续沿用，干净 macOS 账户验收保留到 P6。本轮未推送或发布。

## 1. 把依赖前置与产品缺陷分别处理

台账工具在注册时过早初始化客户端，无运行凭据便注册失败；错误的 PostgreSQL 配置也缺少可定位的报错。这两项通过延迟初始化和错误处理修复。随后首次集成失败来自集成工作树旧 node_modules 缺少新增 pg 依赖，同一候选补做 `npm ci` 后通过。

本轮公共检查已采用 `npm ci` → `npm run verify`。后续交接沿用 [验证准备](development-handoffs.md#验证前准备)，锁文件改变后先准备依赖，再判断源码失败。相关陷阱与原失败摘录见 [依赖未同步](pitfalls/testing.md#合入依赖后仍使用旧安装)。

## 2. 共享接口在冻结候选前交接

#02/#03 共享 Gateway、认证、迁移、备份和会话接口；#04/#05 共享准入、模型选择及 CLI 启动。Main 等原回合结束后，在原执行会话交付具体合并命令与接口变化，再冻结候选审查。模型交接明确排队后、实际准入时解析默认模型，保留显式选择、运行快照和执行主机凭据。

这一做法沿用现有 [派发与返修](development-handoffs.md#派发与返修)：交接生产者、消费者、迁移归属与实际增量。执行中发现组合参数静默丢弃正文的问题，绕行及工具建议见 [WL-03](workloop-followups.md#wl-03-组合参数忽略交接正文)。

## 3. 拒绝启动、重试和收尾各有状态责任

#03 审查发现四项行为：拒绝第二次启动会影响原 Run；缺省 requirement 清空已有归属；有效 retry 未恢复会话 running；共享台账收尾失败影响本地终态。修复将 `onRunAccepted` 放入既有准入锁，保留需求归属，恢复重试状态，并使本地收尾独立完成。

另一次返修修正了并发测试的顺序假设：两个有效请求均携带相同 requirement，断言实际获准者及拒绝方的隔离，保留真实竞争。回归入口为 [MainSession 消费者](../test/p3-main-session-consumers.test.js)；后续修改先核对准入前后和 Task/MainSession/Run 各自的所有权。

## 4. 失败输入保留要覆盖永久与暂时失败

#04 最初在启动失败时丢失输入，且只按 Task 去重，把不同消息误报为成功并清除草稿。修复保留排队输入和可见重试入口，精确输入冲突返回 409，附件身份纳入判断。首次返修只覆盖暂时失败，永久失败仍丢消息，下一轮继续修复。

初审的 Basis 格式被工具误分类为范围外；Main 根据原 AC 与实际数据丢失裁定返修。历史报告保留原标签，P1/P2 已关闭，无豁免。解析问题见 [WL-04](workloop-followups.md#wl-04-审查依据解析后的范围误分类)。现有 [容量生命周期回归](../test/p3-main-capacity-lifecycle.test.js) 保留这几类行为，返修时逐项对应原发现，避免只用一条通过路径关闭整项问题。

## 5. 恢复回收必须复核锁内状态

真实子进程探针发现：重启恢复可能移除仍存活但尚未绑定 PID 的槽位。加入子进程自注册后，恢复端仍可能使用 await 前的旧快照，删除刚完成绑定的槽位，导致超额运行或同请求重派。最终把回收资格复核与条件删除放进绑定共用的锁，删除未使用的 bind-wait 配置。

这次使用了用户已授权的额外返修，未更换执行者绕过计数。最终独立审查在精确旧提交 `4d90cf6` 上验证新测试失败，在修复候选上通过；较早的“禁用修复”实验分别保留。原探针只打印违例却 exit 0，属于证据形式欠缺，见 [WL-06](workloop-followups.md#wl-06-诊断脚本的失败表达)。已有真实生命周期回归继续维护，不追加同义验证框架。

## 6. 组合 UI 与包验收发现消费者遗漏

#06 的真实 UI 流程发现：保存主机模型后项目视图丢失、label/select 选择器冲突、容量表单保存旧值、后台读取覆盖正在输入的值，以及页面需求 origin 错记。修复加入 [角色模型](../test/p3-role-models.test.js)、[容量](../test/p3-main-capacity.test.js) 与容量生命周期回归。

全量包测试又发现新增的 `scripts/main-capacity-gate.mjs` 漏入 CLI 和 Electron 文件清单，已补齐并验证最终包。[CLI 包测试](../test/cli-packaging.test.js) 与 [桌面运行时依赖闭包](../test/desktop-runtime-packaging.test.js) 是后续相关改动的入口。交接应沿现有消费者清单覆盖页面输入、保存、重读，以及运行时导入到实际包的链路。

## 7. 环境与时序失败逐项归因

Python 文档依赖未准备，且测试隔离 hook 清掉了文档约定的 `COWORK_PYTHON`。本轮修复保留覆盖变量，并准备隔离依赖。Electron 二进制未拉取导致 Info.plist 缺失，采用现有 ensure-electron 前置处理。仍可触发的环境条件归 [测试坑点](pitfalls/README.md)。

PTY 文案断行与容量 settle 过早取样在旧基线同条件下也能复现。修复分别允许词间换行、等待持久终态与无活动进程同时成立，原语义断言保留；容量旧基线并行 3 次中 2 次失败。失败、基线和有界修复验证各有日志，未笼统归为“偶发”。

## 8. 减少脚手架试错和重复准备

UI attempt 1–12 失败，13/14 通过，之后固定候选验收通过。失败包括选择器、页面自动展开、证据目录等脚手架问题，以及第 6 节的产品问题。四段固定候选验收又各自重复 setup/verify，早期手工打包与正式打包也有重复。

后续建议先校准低成本 UI 路径和选择器，再执行整条正式流程；同候选、同依赖、同环境可复用已完成的准备，并保留各段身份与漂移检查。已有 [证据复用规则](development-handoffs.md#输出失败与复用) 继续适用。本轮源码发生修复后重新验收，最终同树审查复用 full/package 结果；未重复 P2 原生采样。

## 建议与证据状态

上述产品缺陷已在 P3 修复；复盘新增的流程建议仍待采纳。项目已有交接、失败分类和复用指引，后续优先落实已有入口。Workloop 的缺陷、记录质量问题与工具增强建议分别登记，未修改工具。历史 `suggestions.md` 的 67 条包含重复与已修复事项，不能直接作为开放缺陷清单。

审计的 narrowing 提示已在原复盘答复：相关位置不在上一轮差异内，原 probe 也未非零退出；之后精确旧提交的独立失败测试补齐了证据。retro-none 为登记前状态，现已登记；past-cap 为已授权的额外返修。跨运行审计提示截至本轮已有 8 个 run，自 2026-11-05 上次检查后尚未横向对比，此建议未执行。

## 证据索引

档案标识 `coworkos-p1-docs/os-p3-project-foundation`。下表路径相对于档案根目录；原始日志与安装包独立保存。仓库保留 [脱敏证据摘录](pitfalls/evidence/os-p3-project-foundation/checks.md)，不复制私人路径和操作流水。

| 内容                   | 档案内路径                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 完整复盘、正式登记     | `retro.md`、`retros/1794118328307-48d1f0b1.md`                                                                           |
| 审计与最终验收映射     | `evidence/p3-run-audit-before-archive.txt`、`evidence/p3-run-audit-after-retro.txt`、`final-review.md`                   |
| 共享接口交接           | `evidence/03-merge-02-dispatch-5b894b0b.json`、`messages/04-merge-05-6da228e9.md`                                        |
| #03 所有权与并发修复   | `reviews/03-951727b9.md`、`reviews/03-cad64805.md`、`reviews/03-065fe0d6.md`                                             |
| #04 失败保留与恢复竞态 | `reviews/04-7b8bc726.md`、`reviews/04-f3543e2d.md`、`reviews/04-4d90cf63.md`、`reviews/04-dd3a330e.md`                   |
| #06 分类及逐次原始输出 | `evidence/06-a1/classification.json`、`evidence/06-a1/classification/`、`evidence/06-a1/ac2-ui/`                         |
| 最终候选验收与独立终审 | `evidence/06-a1/acceptance/candidate-e5e9e567/`、`reviews/final-1-11f0f42c.md`                                           |
| 同树对应与完整差异     | `evidence/final-review-preparation/source-correspondence.json` 及同目录差异清单                                          |
| 归档保全与核对         | `evidence/archive-retained/manifest.json`、`evidence/archive-verification.json`、`evidence/archive-main-reconciled.json` |

归档保留 10 份 scratch 原始脚本、3 份基线输入副本、最终及两份早期包、SQLite/PG 备份、失败尝试、19 份 Agent 转录和原始 turns。1006 份保全文件校验通过，6 个外部保护工作树保持不变。已合入的临时工作树与可再生依赖由 Workloop 归档释放，集成分支保留。

P4/P4.5/P5/P6/P7/P8 未启动；阶段范围和下一步归 [阶段规划](development-phases.md) 维护。
