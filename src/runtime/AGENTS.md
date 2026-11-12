# Harness 运行时

从 [代码地图](../../docs/code-map.md) 选择负责该行为的服务；Coordinator 负责协调，不能成为所有新增能力的实现入口。领域类型在 `../domain/`，底层落盘在 `../storage/`，产品工具装配在 `.pi/runtime/`。

- Task、Run、Agent、Job 分别有自己的身份和生命周期；不要用界面状态推导持久状态。
- Run/调度改动覆盖取消、重复启动、进程异常退出、等待中的用户输入和重启恢复。子进程、定时器、文件锁和事件轮询都要有关闭与回收路径。
- 消息交付与恢复从持久事件恢复归属，不能把晚返回消息归到当前选中的 Task，也不能在重试时重复用户输入。
- 模型连接配置、模型档位与请求错误由现有模块管理；改请求协议要覆盖真实 Pi 对接的本地假服务，而非只断言对象字段。
- 产品运行时不导入 Dashboard 或 CLI。新能力通过明确参数、接口与 capability provider 交给宿主装配。

架构和恢复说明见 [当前架构](../../docs/architecture.md) 与 [数据布局](../../docs/task-workspace-layout.md)。运行时测试选择 `test/*supervisor*`、`*inbox*`、`*recovery*`、`model-*`、`*pi*` 中与变更对应的文件；测试命令见 [本地测试](../../docs/testing-local-run.md)。
