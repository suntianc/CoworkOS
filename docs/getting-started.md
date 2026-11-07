# Mac App 快速开始

简体中文 | [English](en/getting-started.md)

<a id="安装与首次使用"></a>

macOS 14+ · Apple Silicon

<a id="mac-app"></a>
<a id="安装前准备"></a>

## 通过 npm 安装

安装 Node.js ≥22.19.0 和 npm 后运行：

```sh
npx coworkos-app@latest desktop install
```

安装器从 npm 获取 Apple Silicon 桌面包，校验 npm tarball 完整性、DMG SHA-256、应用身份和签名后安装到 `~/Applications/CoworkOS.app`，无需管理员权限，并保留 macOS 安全检查。Node.js 和 npm 仅用于安装，App 自带运行时。首次打开若被 macOS 阻止，按 [Apple 安装说明](https://support.apple.com/zh-cn/102445)，在“系统设置 → 隐私与安全性”中允许打开。

已安装的 App 使用本地 DMG 手动升级。先备份数据和外部项目，结束任务并停止独立后端，再退出 App；保留旧 App，将新包拖入安装目录，启动后核对数据。步骤见 [安装与升级](installation-reference.md#更新)。npm 首次安装器不会覆盖已有 App，其他可写安装目录可通过 `--directory /absolute/path` 指定。

npm 更新或卸载 CLI 仅影响 CLI/安装器，不会卸载独立 App 或删除用户数据。当前 beta 尚未通过 Apple 公证。

## 连接模型

打开“设置 → 模型连接”，填写服务商提供的 API 地址、模型 ID 和 API Key。地址填根地址或 `/v1`，例如 `https://your-service.example/v1`。

新连接默认使用 Responses，也可选择 Chat Completions。服务需要支持所选格式的流式响应和工具调用；原生 Anthropic 接口不能直接使用。

点击“测试连接”，通过后点击“保存连接”。测试会消耗模型额度。更多选项见 [模型设置](configuration.md)。

## 创建项目

先在 Finder 的“文稿”中新建一个空文件夹，命名为 `coworkos-quickstart`。

在 CoworkOS 侧栏“项目”旁点击 `+`，填写项目名称并选择这个文件夹。然后点击项目标题旁的 `+`，打开新对话。

## 完成第一个任务

发送：

> 在当前项目中创建 hello.txt，写入“你好，CoworkOS。”，然后读取文件并确认内容。

任务结束后，在 Finder 打开刚才选择的 `coworkos-quickstart` 文件夹。里面应有 `hello.txt`，打开后应看到 `你好，CoworkOS。`。

<a id="cli-安装包"></a>

<a id="从源码运行-cli"></a>

<a id="更新"></a>
<a id="数据退出与升级"></a>
<a id="常见问题"></a>

[CLI](cli-quickstart.md) · [源码安装](development.md#准备环境) · [更新与排错](installation-reference.md)
