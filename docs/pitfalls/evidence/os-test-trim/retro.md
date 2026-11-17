# 测试精简（os-test-trim）摘录

2026-11-17，从已归档 `os-test-trim` 的工单报告、终审和复盘整理。下列路径均相对运行档案；本页保留可追溯事实，省略本机路径、PID 和用户数据。

## 候选身份

| 对象        | 身份                                                    |
| ----------- | ------------------------------------------------------- |
| 集成        | `ab1994bd`（基线 `d3bf1c7`），快进合入 main             |
| finish 全量 | `verify:full` 1895 pass / 0 fail / 3 skipped（共 1898） |
| Playwright  | 330 passed                                              |

## 唤醒 socket 路径超过 sun_path 上限

常驻 Main 的唤醒端点由 `join(tmpdir(), cowork-wake-<uid>, wake-<digest>.sock)` 拼出。Playwright 的运行根目录约 70 字节，端点因此 117–119 字节，超过 macOS `sun_path` 的 104 字节。Electron 内置的 Node 上 `listen` 报 `EINVAL`，Main 日志为 `Main Inbox wake channel failed: listen EINVAL`；普通 Node 上 `listen` 报成功但静默截断，socket 不在记录路径上，随后 `chmod` 报 `ENOENT`，而 `p46-idle-wake-pi` 等 Node 用例因写入方连接的也是截断名而照常通过。结果是桌面重开后新消息留在 Inbox 里，只能等文件事件。#09 让 `agentWakeEndpoint` 在路径过长时退到 `/tmp/cowork-wake-<uid>`，端点写入进程记录，读取方用记录值，并新增 `test/agent-wake.test.js`。来源：`reports/09-a2.md` A 节、`evidence/09-a2/wake-path-probe.txt`。

## 基线即败被豁免为环境问题

终审 r1 的 X1（`appearance-desktop`、`model-protocol-desktop`、`p45-run-control:200` 在候选上 2/2 失败）在基线 `d3bf1c7` 上以相同签名复现后被豁免，理由里写了「两天前 P4.6 finish 通过、当前负载 20–25」。随后 finish 失败，开 #09 才查出上一节的确定性根因，与负载无关；同票中 `p45-run-control:200` 则是断言时机问题（提示只存活约 3.2 秒）。来源：`reviews/final-1-69b9d475.md`、`events.jsonl` 的 `waiver` 与 `finish_failed`、`reports/09-a2.md`。
