<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/readme-hero.png">
    <img src="docs/assets/readme-hero.gif" alt="CoworkOS：几何字标、固定 OS 选框与代码绘制的桌面工作区" width="100%">
  </picture>
</p>

<!-- 待补充讨论区链接。 -->
<p align="center">
  <a href="https://arxiv.org/abs/2611.03178"><img src="docs/assets/badges/paper.svg" alt="论文 · arXiv"></a>
  <a href="https://coworkos-ai.github.io/"><img src="docs/assets/badges/project-page.svg" alt="项目主页"></a>
  <a href="https://coworkos-ai.github.io/showcase.html"><img src="docs/assets/badges/demo.svg" alt="在线演示"></a>
  <br>
  <a href="docs/README.md"><img src="docs/assets/badges/docs.svg" alt="文档"></a>
  <img src="docs/assets/badges/discussions.svg" alt="讨论区">
  <a href="https://www.npmjs.com/package/coworkos-app"><img src="docs/assets/badges/download.svg" alt="通过 npm 安装"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="许可证：MIT；第三方例外见下文"></a>
</p>

<p align="center">
  <b>简体中文</b> | <a href="README.md">English</a>
</p>

> 此分支保留完整的 Main、Coordinator、Subagent、长期任务、记忆和恢复逻辑，移除了内置文本/Markdown、Blender、CAD、PPT 编辑器及其工具、技能、提示词和组件安装器。现有工程文件保持原样；这些文件可通过通用文件工具处理。详见[能力范围与迁移](docs/builtin-capabilities.md)。

**CoworkOS 是一个面向长程、人机在环工作的开源协作运行时。** 它帮助人与智能体把复杂项目从规划推进到经过验证的产出，覆盖代码、研究、文档和科学计算等工作。人和智能体可以查看并修改同一份持续演化的工作；模型服务可配置，项目工作区、记忆和执行记录保存在本机。

- **复杂交付与持续监控。** CoworkOS 面向需要推理、工具使用和验证的复杂生产任务，也面向跨会话或持续数日、需要监控、决策与恢复的工作。长时间运行的 Job 保留状态和日志，使任务在等待或中断后能够继续。
- **用于委派工作的三层运行时。** Main Agent 负责制定计划、委派工作并评估结果；Coordinator Runtime 负责分发子任务并跟踪生命周期；可选的 Subagents 在限定范围内执行具体任务。模型决定任务策略，运行时负责维持协作、反馈和连续性。
- **自动化与持续演化的产物。** 智能体通过 CLI、搜索、文件和 MCP 完成任务；分层工作区、语义记忆和支持修订的候选变更保留审阅与整合流程。
- **面向智能体研究的基础设施。** 同一套机制也支持 RSI 式模型后训练等需要持续监控的循环：分析失败、改进数据、运行训练、验证结果，并在保留状态和证据的情况下迭代。配套研究中，五轮实验将 Qwen3.6-35B-A3B 在八个基准上的平均分从 33.19 提升到 42.95。

## 从源码运行

需要 Node.js ≥22.19.0。此剪枝版本使用本仓库源码运行：

```sh
npm ci
npm run build
npm run ui
# Desktop: npm run desktop
# CLI: npm run cli
```

## 文档与贡献

| 文档                                                     | 说明                                |
| -------------------------------------------------------- | ----------------------------------- |
| [使用指南](docs/README.md)                               | 安装 CoworkOS、配置模型并了解工作流 |
| [模型设置](docs/configuration.md)                        | 配置服务地址、模型 ID 和连接格式    |
| [更新与排错](docs/installation-reference.md)             | 更新、备份、恢复和安装问题排查      |
| [开发指南](docs/development.md)                          | 构建 Web/Desktop/CLI 并运行本地检查 |
| [贡献指南](CONTRIBUTING.md)                              | 贡献流程和验证要求                  |
| [反馈问题](https://github.com/RUC-NLPIR/CoworkOS/issues) | 报告问题或提出改进建议              |

## 致谢与许可

CoworkOS 采用 [MIT](LICENSE) 许可。
