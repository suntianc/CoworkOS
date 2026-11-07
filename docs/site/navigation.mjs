export const navigation = [
  {
    zh: "开始使用",
    en: "Get started",
    pages: [
      ["docs/README.md", "概览", "Overview"],
      ["docs/getting-started.md", "Mac App", "Mac App"],
      ["docs/cli-quickstart.md", "CLI 安装", "CLI installation"],
      ["docs/configuration.md", "模型设置", "Model settings"]
    ]
  },
  {
    zh: "更多功能",
    en: "More features",
    collapsed: true,
    pages: [
      ["docs/project-experience.md", "项目经验与技能", "Experience & skills"],
      ["docs/user-memory.md", "用户记忆", "User memory"]
    ]
  },
  {
    zh: "开发者",
    en: "Developers",
    collapsed: true,
    pages: [
      ["docs/development.md", "开发环境", "Development"],
      ["GLOSSARY.md", "产品术语", "Product glossary (Chinese)"],
      ["docs/retrospectives.md", "复盘落实", "Retrospectives (Chinese)"],
      ["docs/development-handoffs.md", "开发交接", "Handoffs (Chinese)"],
      ["docs/pitfalls/README.md", "项目坑点", "Pitfalls (Chinese)"],
      ["docs/code-map.md", "代码地图", "Code map"],
      ["docs/architecture.md", "架构", "Architecture"],
      ["docs/product-api.md", "HTTP / SSE API", "HTTP / SSE API"],
      ["docs/software-integration.md", "接入应用与工具", "Software integration"],
      ["docs/task-workspace-layout.md", "文件与数据", "Files & storage"],
      ["docs/testing-local-run.md", "测试", "Testing"],
      ["CONTRIBUTING.md", "参与贡献", "Contributing"],
      ["docs/mac-release.md", "Mac 发布", "Mac releases"],
      ["docs/beta-release-process.md", "Beta 发布", "Beta releases"],
      ["docs/development-phases.md", "阶段规划", "Phase plan (Chinese)"],
      ["docs/documentation.md", "文档维护", "Documentation policy"]
    ]
  }
];

const userNames = ["README", "getting-started", "cli-quickstart", "configuration"];
export const userGuideFiles = new Set([
  "README.md",
  "README.zh-CN.md",
  ...userNames.flatMap((name) => [`docs/${name}.md`, `docs/en/${name}.md`])
]);
