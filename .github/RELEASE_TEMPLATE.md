# CoworkOS {{VERSION}}

<!-- 这是草稿模板。发布者须填写本版内容、验收证据与限制；不要把构建成功写成安装/真实模型验收通过。 -->

## 本版变化 / Changes

- 待维护者填写：用户可见改进、修复及对应 issue/PR。
- 待维护者填写：兼容性或数据迁移说明。

## 安装 / Installation

Mac App 目前面向 Apple Silicon、macOS 14 或以上。下载本版本的 DMG 和同名 .sha256，校验后拖入 Applications。{{MAC_SIGNING_NOTICE}}

CLI 需要 Node.js >=22.19.0 与 npm。下载本版本的 tgz 和同名 .sha256，校验后安装；安装仍需要网络和安装脚本：

```sh
shasum -a 256 -c coworkos-cli-{{VERSION}}.tgz.sha256
npm install --global --prefix "$HOME/.local" ./coworkos-cli-{{VERSION}}.tgz
export PATH="$HOME/.local/bin:$PATH"
coworkos init
coworkos doctor
```

详细步骤见 [安装指南]({{REPOSITORY_URL}}/blob/{{TAG}}/docs/getting-started.md)。需要自备模型服务与 API Key；连接测试和任务会消耗模型额度。

## 验收与已知限制 / Validation and limits

- 待维护者填写：绑定本版产物 hash 的系统/芯片、最低 Node、实际安装与任务结果。
- 待维护者填写：真实模型、干净机器、升级、签名/公证分别已验证或未验证。
- 未列出的平台不能视为已支持；源码/夹具通过不能代替发行包验收。
- 升级前结束任务、备份重要数据；首次升级后检查配置、历史、文档和草稿恢复。

## 反馈 / Feedback

请在[同仓库 Issues]({{REPOSITORY_URL}}/issues)反馈，注明版本、平台、安装方式和最小复现；不要上传 API Key、完整私有配置或用户文档。
