# P3 失败与恢复证据摘录

来源：归档 `coworkos-p1-docs/os-p3-project-foundation`，2026-11-08 完成。这里只保留错误、版本关系与结论；原日志、候选和失败尝试保留在档案中，具体路径均相对于档案根目录。

## 依赖与解释器前置

`evidence/integrate-01-e3d2e499.log`：

```text
src/storage/project-data/postgres-database.ts(1,16): error TS2307: Cannot find module 'pg' or its corresponding type declarations.
```

原集成 exit 1。`evidence/integrate-01-dependency-prerequisite.json` 判定工作树缺少新增依赖；同候选增加 `npm ci` 前置后，`evidence/integrate-01-e3d2e499-attempt2.exit` 为 0。

#06 的 `evidence/06-a1/classification.json` 逐项登记：

| 项目        | 原失败                                                       | 修复或准备后结果                                         |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| F2 Python   | 缺少 fitz 等依赖；测试隔离 hook 又清除 `COWORK_PYTHON`       | 选择隔离 venv，并保留该覆盖变量；input-files 4/4         |
| F3 Electron | Electron.app 的 `Contents/Info.plist` 不存在，运行时尚未准备 | 使用 `node scripts/ensure-electron.mjs`；desktop-dev 3/3 |
| F4 PTY      | 基线 `9396f67` 同条件下，词间换行导致提示断言失败            | 保留原词义，允许词间空白；cli-ui-pty 11/11，两次         |
| F5 settle   | 基线并行 3 次中 2 次因过早采样失败                           | 同时等待持久终态和无活动进程；保留有界复验记录           |

原输出在 `evidence/06-a1/classification/`；旧源码与 overlay 身份在 `evidence/archive-retained/manifest.json`，未覆盖失败记录。

## 交接正文与审查分类

`evidence/03-merge-02-dispatch-5b894b0b.json` 记录 `send --merge-tip --file` 的正文忽略行为；实际采用单独 `--file`，文件中含准确合并命令，`messageIncludesFullHandoff` 为 true。

`reviews/04-7b8bc726.md` 的 Basis 组合格式导致工具把 P1/P2 归为范围外；`evidence/04-review-7b8bc726/main-adjudication/` 保存 Main 的原 AC/复现裁定。随后返修关闭，最终 `reviews/04-dd3a330e.md` 通过。原分类继续保留，没有豁免。

## 恢复竞态与 probe 退出状态

`evidence/04-review-4d90cf63/restart-bind-race-output.log` 记录活跃子进程绑定后仍被回收，以及同请求重派；原脚本打印违例但 exit 0。`evidence/04-review-dd3a330e/red-atomic-reclaim-on-4d90cf6.tap` 则在精确旧提交运行新增回归得到失败。修复候选的生命周期验收 18/18 通过。

审计 narrowing 指出相关位置不在上一轮差异内。原 probe 的退出表达不足、后来独立测试补证和用户授权的额外返修分别记录；不把后来的非零失败倒写成原 probe 的结果。

## UI 试跑与最终验收

F6/F7 登记 UI attempt 1–12 失败、13/14 通过，原因涵盖脚手架与五类产品接线缺口。固定候选 `e5e9e567` 的 UI、双引擎场景、同包安装和 full 回执在 `evidence/06-a1/acceptance/candidate-e5e9e567/`。终审 `reviews/final-1-11f0f42c.md` 独立专项 67/67，通过源码同树关系复用 full/package 证据。

完整结果及最终包身份归 [P3 复盘](../../../p3-retrospective.md#交付与验证)，工具建议归 [Workloop 记录](../../../workloop-followups.md)。
