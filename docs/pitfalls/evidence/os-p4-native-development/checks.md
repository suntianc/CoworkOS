# P4 验收与归档摘录

2026-11-09，从已归档 `os-p4-native-development` 的原报告、复盘和归档回执整理。下列路径均相对运行档案；本页保留可追溯事实，省略本机地址、个人路径、PID、用户任务内容和配置。完整分析见 [P4 复盘](../../../p4-retrospective.md)。

## 候选与包身份

| 对象           | 身份                                                               |
| -------------- | ------------------------------------------------------------------ |
| 最终集成       | `762ecb8d1c09739f3bbba78232fbf493982068f1`                         |
| EOF 修复候选   | `888cf982375e669cfaecfd89e43ba1c13013604b`                         |
| 两者共同 tree  | `13ce12e45cc4675f95cb370f485c07efcbacf1ed`                         |
| 原六票验收候选 | `613c4d5fe336935cdad6367742cf9de7aa09d6a3`                         |
| 修复包 SHA-256 | `e51118d1aa8218e6cab0b3b9397a354cd4d9ac7116027714ecd0308d28ef4783` |
| 原包 SHA-256   | `7cdacce23a0dd044fb65193f215fa2e8f7564df7f928c80c019fbacc3d825841` |

原候选到最终树仅改动前台命令相关两模块、一项测试及四份双语文档。原 full 为 2805 tests / 2802 pass / 0 fail / 3 native skips；UI、模型交付及同包 SQLite/PostgreSQL 重启、持久化、备份恢复归于原包。新包补受影响命令和生命周期验证，独立安装探针 6/6。真实模型验收曾有两次人工 SIGTERM 等待 stdin 的自有 awk，原记录保留。

来源：`evidence/final-review-preparation/source-correspondence.json`、`evidence/06-a1/INDEX.md`、`reviews/06-613c4d5f.md`、`reviews/07-888cf982.md`。两个包分别保存在 `evidence/06-a1/cli-package/` 与 `evidence/07-a1/cli-package/`。

## 产品配置前置

外部执行 CLI 已就绪时，OS 的模型连接仍为 `configured=false`。Main 完成不依赖真实模型的同包数据库补证，保留已有取消尝试；用户配置后才恢复原执行者。归档迁移后的就绪记录为 `configured=true`、`credentialUnavailable=false`，Task 已完成、runtime 不活跃。

来源：`evidence/06-main-blocked-reconciliation.json`、`evidence/06-main-model-wait/result.json`、`evidence/main-runtime-relocation.json`、`evidence/archive-verification.json`。不保留密钥或配置正文。

## 审查解析与同版本恢复

#02 的 Basis 以 spec 开头或使用没有冒号的 AC2，#03 使用全角 `AC2：`；工具提示 blocking findings 都在 boundary 外。Main 核对原 AC、调用链及复现后在原范围返修，后续独立复审通过，无 override/waiver。

首轮最终报告使用 `## Verdict` 与 `**pass**`，实际回执为 15 条命令、56 tests 全通过且零漂移，工具却显示 verdict missing。原报告另存，第二轮在同 `762ecb8d` 核对原始回执，补 `Verdict: pass` 和完整 Integration tip，未重复这些检查。

来源：`messages/02-rework-0c5b4ed6.md`、`messages/03-rework-b3703767.md`、`evidence/final-1-verdict-format-reconciliation.json`、`evidence/final-1-format-recovery/final-1-762ecb8d-original.md`、`reviews/final-2-762ecb8d.md`。

## 保全与审计

archive 与保留路径/运行实例验证均 exit 0。归档前确认自有实例已空闲，源码与用户数据迁至独立私有目录，权限和兼容入口保留，原模型配置与样例仍可使用。七个受保护工作树及 Docker 容器身份对账未变。

保留清单含 30 项：16 个原始 scratch 输入、两份基线归档及 overlay 身份、新旧包、数据库备份和安装身份等；原始失败、审查、27 份 turn receipt、21 份导出 transcript 继续保留。档案约 150.5 MiB。scratch 下的兼容链接指向私有现场，需按所有权处理。

审计：7 票、11 个可解析票级报告、12 次 review 事件；同候选报告复用路径造成计数差异，旧版已另存。2 轮终审、0 waiver、0 集成失败、0 冲突、0 retry、0 takeover；无 check flag。提示自 2026-11-05 上次跨运行检查后已有 9 个 run 完成，横向审计尚未执行。

来源：`evidence/archive-retained/manifest.json`、`evidence/archive-verification.json`、`evidence/archive-final-reconciliation.json`、`evidence/retro-audit-after.log`；完整原复盘在 `retros/1794196167522-8a2479f7.md`。
