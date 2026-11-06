---
name: frontend-design
description: 创建或调整网页、落地页与 Web UI 的字体、配色、栅格、留白和视觉层级；已有页面延续设计系统，纯后端修改不需要加载。
---

# 网页设计

先读 [设计与验收](references/design.md)。用真实内容确定受众、页面的主要动作和一个主题相关的视觉锚点；将字体、色板、间距与栅格整理成少量 CSS tokens。已有页面保持品牌、组件和交互一致。

按需组合 [interactive-prototype](../interactive-prototype/SKILL.md)、[hi-fi-design](../hi-fi-design/SKILL.md)、[wireframe](../wireframe/SKILL.md)、[charts](../charts/SKILL.md)、[data-report](../data-report/SKILL.md) 或 [animated-video](../animated-video/SKILL.md)。普通 hover 和过渡用 CSS，不需要时间轴工作流。

沿用项目框架、路由、依赖与资源策略。独立网页可使用 HTML/CSS/JS；需要 React 时使用项目已有依赖和构建工具。外部脚本、字体和图片必须核实可用性，离线交付要包含依赖和许可。路径按 `load_skill` 返回的技能目录解析，不假定当前目录是安装目录。

通过本地 HTTP 预览，检查主要操作、资源加载、控制台、窄屏、长标题与中英文换行。截图用 `read_image` 检查；多图比较可以使用 `paths`，逐页验收仍分别执行。无法渲染时明确说明未完成视觉验证。

独立产物留在当前 Agent work；Main 通过 `publish_artifact` 发布入口及相对依赖，Subagent 返回 deliverables 候选。已有项目源码在所选目录修改。只有用户要求线上交付时才使用已配置的部署能力。
