# Pi 运行时

## 升级 Pi 后新版默认开启的能力改变行为

- **Trigger：** 升级 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`，或调整启动器 `scripts/start-pi-runtime.mjs` 的参数。
- **What happens：** 新版可能默认开启新能力。1.5.2 中内置 MCP 会读取用户的 `mcp.json`，给 Main 增加 `mcp__*` 工具；交互 TUI 默认全屏；`cacheWarming` 默认开启。工具表和用户可见行为因此在用户不知情时改变。
- **Confirm：** 用 `node scripts/test.mjs --skip-build --file test/p46-pi-upgrade-pi.test.js` 对比请求结构、工具表与系统提示段落和冻结基线 `test/fixtures/p46-pi-upgrade-baseline.json`；逐条阅读 `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` 两个版本之间的条目，找出「默认」变化。
- **Avoid：** 行为不变的升级中，新版默认开启的能力一律显式关闭，不以「当前连接上不生效」为由保留；现有关闭点为启动器的 `--no-mcp`、`--tui-mode regular` 与 Main 扩展的 `cache_warming_decision`。派单与审查清单同时列出这一条。确需采用的新能力单独开票。
- **Sources：** 2026-11-13 [P4.6 摘录](evidence/os-p46/retro.md#pi-升级与回滚第二轮)。

## 升级后 CLI 策略哈希与深路径导入失效

- **Trigger：** 升级 Pi 包后构建或运行 CLI 界面兼容检查。
- **What happens：** `scripts/cli-ui-policy.json` 与 `scripts/cli-shell-policy.json` 锁定包内 `dist/bundle/` 文件的 SHA-256 和补丁锚点，新版 bundle 不匹配时检查失败；直接引用包内部文件的导入（例如 `pi-agent-core/harness/*`）可能已被移除，TypeBox 也不再由 `pi-ai` 重导出。
- **Confirm：** `node scripts/test.mjs --skip-build --file test/cli-ui-compatibility.test.js`；`shasum -a 256` 对照策略文件中的 bundle 哈希；`rg "@earendil-works/pi-(ai|agent-core)/" src .pi scripts` 列出深路径导入，逐个确认新版仍存在。
- **Avoid：** 升级时同步重新生成两份策略文件（由 `build-cli-ui.mjs` 的同一选择逻辑生成，逐处复核 UI 差异），`Type`/`Static`/`TSchema` 从与 Pi 同版本的直接依赖 `typebox` 导入。
- **Sources：** 2026-11-13 [P4.6 摘录](evidence/os-p46/retro.md#pi-升级与回滚第二轮)。

## 只降级 Pi 包无法回滚

- **Trigger：** Pi 升级后出现问题，准备把三个包降回旧版本。
- **What happens：** 升级提交同时改了启动参数、策略哈希和直接依赖。只降级包时旧版 Pi 以 `Error: Unknown option: --no-mcp` 退出，策略哈希也不匹配。
- **Confirm：** 用旧版 bundle `cli.js` 加 `--no-mcp --mode rpc` 启动，观察退出信息；`git diff <升级提交>^ <升级提交> | git apply -R --check -` 确认整体撤销可以干净应用。
- **Avoid：** 按 [运行参考](../runtime-reference.md) 的回滚步骤撤销整个升级提交后 `npm ci`、构建、`npm run verify`。会话文件两个方向都能续用（`test/p46-session-compat-pi.test.js`）；之后再次升级不能只改 `package.json`。
- **Sources：** 2026-11-13 [P4.6 摘录](evidence/os-p46/retro.md#pi-升级与回滚第二轮)。

## 依赖文件事件送达消息或唤醒

- **Trigger：** 让 Pi 进程靠文件监听（FSEvents / `fs.watch`）得知收件箱新消息或被唤醒。
- **What happens：** 本机 `fseventsd` 长期约 100% CPU 时，文件事件迟到或丢失是常态，空闲的 Main 或子代理收不到消息，测试偶发超时。
- **Confirm：** `ps -Ao pcpu,command -r | head` 看 `fseventsd` 占用；关闭文件监听（`COWORK_DISABLE_FILE_WATCH=1`）后相关真实进程测试仍应通过。
- **Avoid：** 送达以回合边界重读收件箱（`turn_end`）和写入方直接唤醒（`src/runtime/agent-wake.ts`，`COWORK_WAKE_ENDPOINT`）为准，文件监听只作补充；不要新增只靠文件事件的路径。
- **Sources：** 2026-11-16 [P4.6 摘录](evidence/os-p46/retro.md#文件事件不可靠第三轮)。
