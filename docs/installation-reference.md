# 安装、更新与排错

简体中文 | [English](en/installation-reference.md)

首次安装见 [Mac App](getting-started.md) 或 [CLI 快速开始](cli-quickstart.md)。

## 名称与旧版兼容

产品名称为 CoworkOS，logo 保持不变。主命令为 `coworkos`，发行包保留 `atria` 兼容别名；npm 包仅提供 `coworkos` 命令。

首次启动或运行 `coworkos doctor` 时会刷新旧版搜索适配器的运行时路径；仅处理本产品标记的脚本，保留用户自行安装的工具和符号链接。

现有的 `~/.atria/`、`ATRIA_*` 环境变量、桌面 bundle ID、系统钥匙串身份和持久格式标识保持不变，已有配置与任务无需迁移。旧版 `Atria` / `Atria Dev` 数据目录仍可识别。GitHub 仓库地址与历史版本附件保持原地址；新构建使用 CoworkOS 应用名及 `coworkos-cli` 附件名（Release 发行包内部包名保留 `atria-cowork-cli` 以兼容升级；npm registry 包名为 `coworkos-app`），并能读取旧版更新附件。

旧版 App 的更新地址保存在旧二进制中；当前安装版使用本地 DMG 手动升级，旧数据保留在用户目录。

旧版源码更新器也会拒绝新的项目名称。首次跨越更名时，先保存并结束任务，在干净、有上游分支的检出中执行 `git pull --ff-only`、`npm ci` 和 `npm run build`，然后重启。新更新器支持旧项目名 `cowork-harness` 向 `coworkos` 的单向升级，仍拒绝其他项目标识及反向更名。

## 更新

更新前保存文档，并结束运行中的任务。

Mac App 使用本地 DMG 手动升级：

1. 备份 `~/.atria/`（或实际 `ATRIA_HOME`）和外部项目；结束运行中的任务。对每个运行中的数据目录，使用相同版本 CLI 执行 `coworkos backend stop`，确认返回 `stopped` 或 `absent`；再退出 App。
2. 核对 DMG 的 SHA-256，打开 DMG。将旧 App 改名保留，再把新 App 拖到原安装目录。安装资源与用户数据分开，替换 App 不覆盖用户数据。
3. 打开新 App，检查连接、会话、附件与设置。若启动或数据校验失败，退出新 App，恢复保留的旧 App 和必要的数据备份，再重试。

独立后端的启动、状态与停止命令见 [开发指南](development.md#独立后端)。正式签名、公证和自动更新属于后续 P6。

npm 安装先退出 CLI，再更新：

```sh
npm install -g coworkos-app@latest
```

`coworkos update --check` 检查 npm 版本，`coworkos update` 显示对应的 npm 命令。npm 安装器不替换独立桌面 App；App 按上面的步骤手动升级。

Release 发行包或源码安装先退出交互界面，再在系统终端运行：

```sh
coworkos update --check
coworkos update
coworkos --version
```

`--check` 只检查，不安装；`update` 完成后，下次启动使用新版本。非全局 CLI 安装使用原包管理方式升级。源码检出的更新条件与命令见 [开发指南](development.md#更新源码检出)。

## 数据与备份

配置和任务默认保存在 `~/.atria/`，项目文件保存在启动 CLI 时所在的项目目录。可在终端查看实际路径：

```sh
coworkos data paths
```

备份时同时保留重要的用户数据和外部项目原文件，详细布局见 [工作区与持久化](task-workspace-layout.md)。更新会保留已有数据；不要通过删除用户目录排错。App 重开后可在原对话继续，CLI 的退出与恢复见 [CLI 快速开始](cli-quickstart.md)。

## 常见问题

### `node: command not found` 或 Node.js 版本过低

先从 [Node.js 官网](https://nodejs.org/en/download)安装 Node.js 22.19.0 或更新版本，再重新打开终端运行：

```sh
node --version
npm --version
```

两条命令都能显示版本后，再执行 CLI 安装命令。

### `coworkos: command not found`

如果按快速开始安装到了 `~/.local`，在当前终端运行：

```sh
export PATH="$HOME/.local/bin:$PATH"
coworkos --version
```

要在新终端保留 PATH，按实际使用的 shell 选择下面一条命令，只需添加一次。可先用 `echo "$SHELL"` 查看。

zsh（macOS 默认）：

```sh
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
```

bash（常见 Linux 终端）：

```sh
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
```

重新打开终端，运行 `coworkos --version` 确认。

### 安装或校验提示 `ENOENT` / `No such file or directory`

先进入保存安装包的目录，再检查两个文件是否都在。若不在 `~/Downloads`，替换第一行路径：

```sh
cd "$HOME/Downloads"
ls coworkos-cli-0.1.2-beta.12.tgz coworkos-cli-0.1.2-beta.12.tgz.sha256
```

文件名中的版本必须与实际下载版本一致。缺少文件时，从 [CLI 下载步骤](cli-quickstart.md#下载并安装)重新下载，再校验和安装。若校验显示 `FAILED`，重新下载两个文件；校验通过后再安装。

### npm 全局安装提示权限错误

如果错误指向系统全局安装目录，改用用户目录安装。从安装包所在目录运行：

```sh
archive="coworkos-cli-<version>.tgz"
npm install --global --prefix "$HOME/.local" "./$archive"
export PATH="$HOME/.local/bin:$PATH"
coworkos --version
```

若安装在下载平台依赖时失败，恢复网络后重新运行安装命令；不要用 `--ignore-scripts` 跳过安装脚本。

### `配置已存在，未覆盖`

`coworkos init` 只创建新配置，不会覆盖已有文件。先在项目目录运行：

```sh
coworkos doctor
```

查看输出中的“配置路径”。已有配置有效时可直接运行 `coworkos`；需要修改时，打开该路径的文件，修改 `baseUrl`、`model`、`apiKey` 或 `api`，具体取值见 [CLI 配置文件与环境变量](configuration.md#cli-配置文件与环境变量)。`coworkos init --force` 会保留已填写的字段，不会重新询问全部连接信息。

### `FAIL 模型配置` 或 `FAIL 流式模型连接与工具调用`

先看同一行的错误和输出中的“配置路径”：

- 配置缺失：在项目目录运行 `coworkos init`，填写服务商提供的 API 地址、模型 ID 和 API Key。
- JSON 无效或模型字段不合法：打开打印的配置文件，按 [CLI 配置](configuration.md#cli-配置文件与环境变量)修正；不要将整份配置或密钥发到反馈区。
- 服务只支持 Chat Completions：在当前终端运行下面的命令，再测试。
- 认证、权限或额度错误：核对服务商的 API Key、模型访问权限及余额，再测试。

```sh
export COWORK_MODEL_API=openai-completions
coworkos doctor --test-connection
```

上面的格式切换只用于 Chat Completions 服务，且只在当前终端生效。持久设置见 [CLI 配置](configuration.md#cli-配置文件与环境变量)。Responses 服务修正配置后，直接重跑 `coworkos doctor --test-connection`。只有所有检查通过后再开始任务。

### Mac App 首次打开或保存连接失败

首次打开被 macOS 阻止时，按 [Mac 安装指南](getting-started.md#mac-app)处理系统提示。保存连接停在“保存中”时，处理钥匙串授权提示；若已拒绝，再次点击保存重试。

反馈问题时提供版本、系统与芯片、安装方式、复现步骤和脱敏错误。请勿发送 API Key、完整私有配置或未经筛选的任务日志。
