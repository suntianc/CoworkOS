# P4.6 剔除与 Pi 升级摘录

2026-11-13，从已归档 `os-p46-removal`（第一轮，剔除）与 `os-p46-pi-upgrade`（第二轮，Pi 升级）的工单报告、审查和复盘整理。下列路径均相对各自运行档案；本页保留可追溯事实，省略本机路径、PID 和用户数据。

## 候选身份

| 对象                  | 身份                                         |
| --------------------- | -------------------------------------------- |
| 第一轮集成            | `5202a8c8`，合入 main `0536c14`              |
| 第二轮集成            | `74e723ad`，合入 main `6d672c8`              |
| Pi 升级提交           | `4e5bde0`（0.87.1 → 1.5.2）                  |
| 第二轮终审全量        | `verify:full` 2211 pass / 0 fail / 3 skipped |
| 第二轮终审 Playwright | 336 passed / 1 skipped                       |

## 开关替换后旧用法残留（第一轮）

#03 新增 `COWORK_DISABLE_MAIN_GUARDIAN`，#04 删除旧开关 `COWORK_DISABLE_WATCH_SUPERVISOR` 时没有替换，约 80 处测试启动的后端开始运行 Main 守护，时序测试偶发失败。Main 起初判断为负载偶发，在 main 上对照连跑 5 次后才确认是回归，#07 修复并新增扫描测试 `test/p46-guardian-off-in-tests.test.js`。来源：`os-p46-removal/retro.md` §1、`reports/07-a1.md`。

## 偶发失败的基线对照（第二轮）

终审在集成分支上把 `e2e/file-upload.spec.js` 连跑：tip 13 次失败 3 次（约 23%），基线 `0536c14` 18 次失败 7 次（约 39%），失败签名相同（`[data-upload-retry]` 可见性超时）。判定为既有竞态，不是本轮回归。#01 审查时同一用例约 1/35，终审当天机器负载约 10，失败率明显升高。来源：`os-p46-pi-upgrade/reviews/final-1-74e723ad.md` Regression 节、`evidence/final-1-74e723ad/flake-probe/`。

## 高负载下的动画帧用例（第二轮）

finish 的 Playwright 全量中 `e2e/p45-motion.spec.js:44` 失败（断言没有抓到动画中间帧），此时 load average 约 10，主要来自系统进程；同一提交上单独重跑 3 次均 4/4 通过，终审全量中也通过。本轮没有改动画与样式。来源：`evidence/checks/finish-2026-11-13T01-48-54-506Z/24.log`。

## Pi 升级与回滚（第二轮）

- 1.x 默认加载内置 MCP（读取用户 `mcp.json` 增加 `mcp__*` 工具）、1.0 起交互 TUI 默认全屏、1.5.1 起 `cacheWarming` 默认 `"idle"`。启动器加 `--no-mcp` 与 `--tui-mode regular`，Main 扩展对 `cache_warming_decision` 返回 `stop`。#05 曾以「对 CoworkOS 连接惰性」为由未关闭 `cacheWarming`，审查未拦，#07 按派单原则补上。
- `pi-ai` 1.5 不再重导出 TypeBox，`pi-agent-core/harness` 被移除；`scripts/cli-ui-policy.json` 与 `scripts/cli-shell-policy.json` 锁定 bundle 哈希，升级时需重新生成。
- 只把三个 Pi 包降到 0.87.1 无法启动：0.87.1 报 `Error: Unknown option: --no-mcp`，策略哈希不匹配，顶层也没有 `typebox`。回滚改为撤销升级提交，见 [运行参考](../../../runtime-reference.md)。
- 来源：`os-p46-pi-upgrade/reports/05-a1.md`、`reports/06-a1.md`、`evidence/06-a1/old-pi-rejects-no-mcp.log`、`reviews/07-a088c993.md`。

## Workloop 行为

- 第一轮 #05 的 `send --merge-tip` 回合执行者没有真正合并，集成时才冲突；之后每次发送合并请求都用 `git merge-base --is-ancestor <tip> HEAD` 核对。来源：`os-p46-removal/retro.md` §2。
- 第二轮终审已在 `74e723ad` 上跑过全量，finish 在同一提交上又跑了 24 条检查（含全量），其中一条偶发失败后再跑一次 finish 又耗 16 分钟。来源：`evidence/checks/finish-*`。
