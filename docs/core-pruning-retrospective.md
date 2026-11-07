# 科学工具与旧资产剪枝复盘

日期：2026-11-07。档案标识 `coworkos-p1-docs/os-core-pruning`，交付提交 `fb054a155e696663fb76ae35f57d00ab99c1cc42`。六条验收标准保持原样，独立审查、交付检查和归档完成，无豁免或集成失败。本文从运行复盘整理项目经验，当前落实状态见 [汇总](retrospectives.md)。

## 交付与验证

科学工具注册、执行、安装和设置接线及专项 Office 创作技能已移除；通用文件、项目 Python、Pi/Main/子代理、MCP、恢复、PDF 内建显示和必要附件读取保留。清理回执记录六项非活动旧资产及两个孤立标签，归属不明确的通用缓存保留。

实现候选 `cc09ee0` 的全量检查为 2,699 tests、2,696 pass、0 fail、3 skip；最后候选 `00bd063b` 仅修改 README 英文措辞。两轮独立审查执行专项验收，最终 14/14 通过；集成和交付按原配置完成轻量验证与专项验收。CLI、Electron、原生和清理回执保留原候选身份。

## 1. 能力删除要覆盖发布目录与双语入口

首次全量检查发现 release catalog 仍引用已删除的 Office 测试，随后修正 native variant 的数量断言。首轮独立审查发现英文 README 仍写 scientific workflows，第二轮确认改为 data analysis。现有 catalog 自测和双语约定继续使用；删除能力的消费者清单已加入 [交接指南](development-handoffs.md#派发与返修)。

## 2. 清理必须确认跨工作区归属

不同 workspace 可以使用相同 Task ID；仅按本地任务消失判断会误删共享标签。最终实现保留归属不明确的标签，已有 [跨工作区边界回归](../test/science-removal.test.js)。真实清理前使用隔离 fixture 验证预览、删除、重入、活动任务与符号链接边界；实际清理和对应失败/成功证据均已完成留存。

## 3. 执行 CLI 切换会改变 Python 解析结果

Terra 使用的 Python 3.13.11 有文档依赖；DSH 首次检查解析到 3.15.0，`test/input-files.test.js` 的文档 fixture 报 `ModuleNotFoundError: No module named 'fitz'`。选择已有依赖环境后同一组检查 14/14 通过。交接须明确解析路径、版本和依赖；当前夹具与读取器支持 `COWORK_PYTHON`，见 [环境说明](development.md#准备环境) 和 [测试陷阱](pitfalls/testing.md#切换执行-cli-后文档夹具缺库)。

## 4. 返修验证需要明确各阶段责任

一行 README 返修虽然有窄交接，执行者仍重复轻量验证、提交前后文档检查和专项验收。后续简报将本轮差异检查、审查/集成/交付必需命令及可复用证据放在同一位置。提交后默认格式命令的空选择另见 [格式检查陷阱](pitfalls/testing.md#提交后格式检查没有选中文件)。全量、包、原生和性能证据已复用，未为文案重跑。

## 5. provider 替换与返修计数要分别核对

用户要求后续改为 DSH `deepseek-v4.1-flash` high 执行、Devin `swe-2-max` 审查。运行保留正在执行的 Terra 回合，随后借 `retry` 交接原工作树给 DSH。实际发生一次 README 返修；工具机械 rework 为 0，原因和前轮发现已写入事件及交接。项目交接据实登记，工具改进见 [单列建议](retrospectives.md#单列的-workloop-建议)。

## 保留证据

以下路径相对于运行档案。仓库仅保存 [Python/格式证据摘录](pitfalls/evidence/os-core-pruning/checks.md) 与 [相关原复盘摘录](pitfalls/evidence/os-core-pruning/retro.md)；完整输出、包及四个 agent 转录继续在档案中保存。

| 证据                  | 档案内路径                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| 原复盘与审计          | `retro.md`、`retros/1794060320961-42ec4518.md`、`evidence/audit-before-retro.txt`                |
| 发布 catalog 初始失败 | `evidence/01-a1/final-verify-full/check-1.log`                                                   |
| 跨工作区红绿证据      | `evidence/01-a1/cross-root-red-v2.log`、`evidence/01-a1/cross-root-green.log`                    |
| Python 失败与通过     | `evidence/01-a2/ac6-committed.log`、`evidence/01-a2/ac6-committed-condapy.log`                   |
| 窄返修与独立复审      | `messages/01-rework-1-readme-dsh.md`、`messages/01-rereview-readme.md`、`reviews/01-00bd063b.md` |
| 引用及包保留          | `evidence/archive-citation-inventory.json`、`evidence/archive-retained/manifest.json`            |

归档保存最终/早期 CLI tar、接受过的 Electron App ZIP、合成边界 fixture 和全部已引用失败记录，约 249 MiB 为有用途的包证据。报告引用的 11 个 scratch 路径有保留映射，其中两个为 fixture 成功删除后的预期缺失。无关工作树与开发数据保留。
