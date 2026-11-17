# 真实模型 Browser Use 验收

本专项指南为中文。此验收独立于确定性回归，需要已有的桌面默认多模态连接、Electron 和 Chromium；会实际调用该模型。普通测试、脚本帮助和无参数运行均不发出模型请求。

```bash
npm ci
npm run build:cli
npx playwright install chromium
node scripts/validate-cua-live.mjs --help
node scripts/validate-cua-live.mjs --run --evidence-dir ../cua-validation-evidence
```

默认总时限五分钟，可用 `--timeout-ms` 调整为 10–600 秒。`--evidence-dir` 必须在仓库外，保存不含密钥、服务地址、随机答案或模型原文的 JSON 验收记录；未指定时使用系统临时目录中的 `atria-cua-live-receipts`。退出码 0 表示所列检查全部通过，1 表示失败或环境不满足。

连接读取复用执行主机自己的配置与凭据存储读取（`readCoworkConfig`、`HostCredentialStore`），取 Main 默认使用的模型。默认数据位置沿用桌面 `ATRIA_HOME` / `COWORK_DESKTOP_DATA`。不修改模型设置、不复制密钥；凭据存储无法读取、未配置模型或默认模型未启用图像输入时记为未完成验收。

运行器通过生产 `desktop/backend.cjs` 启动独立后端，使用自己的临时 workspace、配置、索引和 Pi 目录，仅创建一个专用 Task。配置文件仅保存非密钥字段；模型连接在内存中交给宿主。控制目标是隔离的 headless Chromium，不接管用户浏览器或原生应用。

本地 fixture 将每轮随机六位数字画入 PNG，再显示在 canvas 中，答案不进入 DOM 文本或 URL。模型需要放大截图裁剪、自行识别、跨 cell 复用 Tab，用 scoped locator 在重复控件中选择正确表单，以低成本观察连续填写、保存、等待和下载，最后检查实际页面和下载文件。

验收由运行器独立判断：

- `crop_image` 实际返回放大 mapping；至少两个成功脚本 cell，且一个包含多个成功浏览器动作。
- 脚本使用正确表单的作用域定位，至少两个成功动作未生成截图，最终 ARIA 观察实际成功。
- 服务端校验随机值和指定备注，至多三次尝试、恰好一次成功，无重复提交或误操作诱饵表单。
- 恰好一个实际下载，运行器读取 Task 文件，将完整字节与服务端 receipt 比较并计算 SHA-256；模型自称完成不能代替此检查。

原始 Pi 会话、模型输出、运行日志和截图留在本轮独立的系统临时目录 `atria-cua-live-<validationId>-*`，不会进入源码或验收 JSON。它们可能含任务内容与完整脚本，只用于本地诊断，不要直接上传。运行器结束后关闭自己的后端、浏览器和 fixture，不清理用户任务。

这个验收覆盖真实模型规划与识别、生产桌面设置读取→后端→Main/Pi→QuickJS→Chromium→图片归档/裁剪→实际下载链路。它不验证原生桌面权限、商业网站兼容性、跨平台安装或模型对所有字体的识别质量；这些需要各自的验收证据。实现为 [运行器](../scripts/validate-cua-live.mjs) 与 [隔离页面](../test/cua-live-fixture.mjs)。
