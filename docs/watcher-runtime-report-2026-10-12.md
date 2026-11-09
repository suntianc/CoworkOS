# Watcher 全链路：2026-10-12 历史范围

本页保留原阶段的能力范围与限制，便于解释 PR 历史；不是当前分支或安装包的验收记录。当前行为分别由 [运行时参考](runtime-reference.md#长期目标接口与调度)、[架构](architecture.md#长期目标监控与暂停)、[HTTP API](product-api.md#persistent-monitors) 与 [目标架构](long-term-goals-architecture.md) 维护。

原阶段接入了六类参考模板、会话/独立后台归属、Dashboard 调度与 Main 唤醒，以及监控列表/控制。可靠性工作覆盖 state/outbox checkpoint、隔离探针、重复登记、预算、失败退避和 Task 生命周期；模板与本地协议来源只证明对应受控路径，不能替代真实模型与线上信息源的长期质量。

## 不得沿用的历史结论

- 原阶段的用例数量、规则哈希和本机结果仅对应当时源码；当前验证绑定当前 commit、环境、命令及跳过项。
- 旧“尚无 OS 服务”描述已由显式 macOS 用户级 launchd 入口补充；普通启动仍不自动安装常驻服务。
- 旧“监控任务”布局不代表当前目标页面；现行目标、动态、计划、设置与暂停语义见 [交互](long-term-goals-ux.md) 和 [暂停契约](monitoring-pause-contract.md)。
- 来源窗口、机器休眠/关机、认证与外部服务可用性仍会限制补齐能力；不能承诺完整捕获所有变化。

## 现行验证入口

[目标模型](../test/long-term-goals.test.js)、[目标工具/Pi](../test/goal-tools.test.js)、[可靠性](../test/watch-reliability.test.js)、[恢复](../test/watch-supervisor-recovery.test.js)、[采样活性](../test/watch-sampling-liveness.test.js)、[暂停](../test/monitoring-pause.test.js)、[服务定义](../test/monitor-service.test.js)、目标与监控的浏览器用例已随 P4.5 移除界面入口删除。本次文档合并未执行这些测试。

真实模型、来源、macOS 服务安装/退出与多日驻留各自记录证据，不把协议夹具、命令定义或成功构建写成实际用户环境已通过。
