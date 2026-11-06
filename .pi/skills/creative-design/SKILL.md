---
name: creative-design
description: 按交付媒介组织网页、UI 设计、交互原型、图表报告和浏览器动画的制作与验收；普通后端修改不需要加载。
---

# 创意设计与制作

1. 读取用户需求、源数据、品牌、现有代码及参考图片。沿用已有技术栈和设计系统；只澄清会改变核心交付的未知信息。
2. 加载 [frontend-design](../frontend-design/SKILL.md)，先确定页面的受众、主要任务、字体、配色、栅格和视觉锚点。
3. 按实际交付媒介加载下面的技能，形成简短结构后制作可预览产物。不要为一个任务加载整个目录。
4. 使用项目的构建与检查流程；有浏览器能力时通过 HTTP 检查资源、控制台、主要操作、桌面和窄屏布局。用 `read_image` 检查当前截图，失败或缺少结果不能算视觉验收。
5. 在当前 Agent 工作目录制作独立产物。Main 用 `publish_artifact` 发布最终入口及全部相对资源；Subagent 将候选放自己的 deliverables，返回路径和验证证据。已有项目直接在所选项目目录修改。

| 交付                        | 技能                                                       |
| --------------------------- | ---------------------------------------------------------- |
| 视觉系统与网页排版          | [frontend-design](../frontend-design/SKILL.md)             |
| 高保真多方案                | [hi-fi-design](../hi-fi-design/SKILL.md)                   |
| 低保真布局与流程            | [wireframe](../wireframe/SKILL.md)                         |
| 可点击 demo、表单与多步状态 | [interactive-prototype](../interactive-prototype/SKILL.md) |
| 图表与指标                  | [charts](../charts/SKILL.md)                               |
| 数据报表与看板              | [data-report](../data-report/SKILL.md)                     |
| 信息图与专题长页            | [visual-exposure](../visual-exposure/SKILL.md)             |
| 浏览器时间轴动画            | [animated-video](../animated-video/SKILL.md)               |

HTML、PDF 和视频是不同交付格式，必须按请求实际生成。

只调用当前会话实际提供的工具。部署使用用户指定且已配置的平台，在已有授权范围内执行并验证线上结果。平台未配置时继续完成可交付的本地文件。
