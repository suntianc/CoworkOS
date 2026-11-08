# 配置参考

简体中文 | [English](en/configuration-reference.md)

日常连接和设置操作见 [模型与运行配置](configuration.md)。

## 模型参数

| JSON 字段                             | 取值与默认行为                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `baseUrl`                             | 服务根地址或 `/v1`；兼容旧字段 `apiBase`                                         |
| `model`                               | 服务商模型 ID                                                                    |
| `apiKey`                              | 私有配置中的密钥，也可用 `COWORK_API_KEY`                                        |
| `api`                                 | `openai-responses` 或 `openai-completions`；新连接默认前者，旧配置缺失时保留后者 |
| `supportsImages`                      | 新连接默认 `false`                                                               |
| `thinkingFormat`                      | `auto`（默认）、`openai` 或 `zai`，仅影响 Chat Completions                       |
| `reasoningEffort`                     | `off`、`low`、`medium`、`high`、`xhigh`、`max`；服务需支持所选值                 |
| `supportsReasoningEffort`             | 新连接默认 `false`，不发送强度字段                                               |
| `supportsPromptCacheKey`              | 第三方服务默认 `false`，确认支持后开启                                           |
| `contextWindow`                       | 默认 256000 token，需为正的安全整数                                              |
| `mainMaxTokens` / `subagentMaxTokens` | 新连接均为 8192；整数 1 至 65536，且不超过服务上限                               |
| `workspaceRoot`                       | 持久任务及应用资源目录，建议绝对路径                                             |

`contextWindow` 用于 Main、子智能体及恢复任务的上下文预算和自动压缩，不作为模型请求参数发送。旧连接缺少该字段时使用 256000。输出上限另行设置。

`off` 始终省略强度字段。旧 `minimal` 值仍可读取，界面标为旧配置；编辑其他字段会保留它，选择并保存其他强度后才替换。未显式配置的旧连接可能沿用 Runtime 的 `high` 和推理支持默认值，新连接使用 `off` / `false`。

连接测试、Main 和子智能体共用能力校正及请求序列化规则。显式强度被服务拒绝时，测试失败，不自动换档。测试使用短合成消息和测试工具，不发送真实会话历史；开启图像后会检查合成图片的底色与随机大号数字 2 或 4。长上下文、内容策略和实际任务需另行验证。

自定义 GLM 网关未被 SDK 识别时，可选“GLM 格式”或设置 `thinkingFormat: "zai"`：开启思考发送 `thinking: {type: "enabled", clear_thinking: false}`；关闭发送 `thinking: {type: "disabled"}` 并省略 `reasoning_effort`。`openai` 使用标准强度字段，`auto` 使用 SDK 自动识别。此设置随连接传递给 Main、子智能体和恢复任务；Responses 协议不变。

`supportsPromptCacheKey` 控制第三方服务的 `prompt_cache_key`。开启后发送稳定会话键，超过 64 个字符时使用 SHA-256；默认省略。`api.openai.com` 保留 SDK 默认行为，程序化的 `cacheRetention: "none"` 始终省略该键。键随连接用于 Main、子智能体和恢复任务，但不能启用服务端缓存或保证命中；自动前缀缓存也可能不依赖此键。

## CLI 配置文件

启动器选择第一份匹配的文件，文件间不合并：

1. `COWORK_CONFIG` 指定的文件。
2. 启动目录的 `.cowork/config.json`。
3. 启动目录的 `config.json`。
4. `~/.atria/config.json`，或 `ATRIA_HOME/config.json`。

启动或运行 `doctor` 时，`COWORK_CONFIG` 指定的文件必须存在；`init` 可以在该路径创建新文件。选中文件的 JSON 或字段无效时直接报错，不回退到下一项。

环境变量覆盖选中文件，对应入口的显式参数再覆盖同名设置，例如 Main 的 `--thinking low`。相对配置路径按启动目录解析。

`coworkos init` 默认创建用户配置；若已有项目配置或设置了 `COWORK_CONFIG`，则使用对应文件。已有文件默认拒绝覆盖。`coworkos init --force` 读取并更新已有配置，复用已保存的地址、模型和密钥，只询问缺失的必填值。修改地址或模型时传入 `--base-url`、`--model`；更换密钥时先设置 `COWORK_API_KEY`，或用 `--api-key-env` 指定保存新密钥的环境变量。其他字段及既有消息格式保留。

已有文件无法解析或字段无效时，先修正文件；`--force` 仍会读取它。自动化初始化可从已设置的环境变量读取密钥：

```sh
coworkos init --base-url https://your-service.example/v1 --model your-model-id --api-key-env COWORK_API_KEY
```

可选参数：`--images`、`--reasoning`、`--thinking high`、`--max-tokens 8192`、`--force`。`init` 没有消息格式选项。仅支持 Chat Completions 的服务需在所选配置文件中设置 `"api": "openai-completions"`，或在启动 CLI 时设置 `COWORK_MODEL_API=openai-completions`。

要为当前项目创建独立配置，在项目目录运行：

```sh
COWORK_CONFIG="$PWD/.cowork/config.json" coworkos init
```

初始化会创建所需目录。完成后运行 `coworkos doctor` 确认实际选中的配置路径。

源码开发也可在 CoworkOS 源码仓库根目录复制示例：

```sh
mkdir -p .cowork
cp config.example.json .cowork/config.json
chmod 600 .cowork/config.json
```

替换示例地址、模型和密钥，也可移除 `apiKey` 并使用环境变量。示例 `workspaceRoot: ".tmp"` 适用于源码开发；跨项目复用任务宜使用固定绝对目录。不要将真实密钥写进命令参数或共享脚本。

源码 Web 使用同一文件优先级，已安装 App 由宿主管理配置。`coworkos doctor` 会检查环境、配置和工作区写入，并以临时文件验证离线查找、内容搜索及忽略规则，不打印密钥。加上 `--test-connection` 才请求模型。

Finder/Dock 启动的 macOS App 会将存在的 `~/.local/bin`、Homebrew `bin`/`sbin`、`/usr/local/bin`/`sbin` 和用户或系统 LibreOffice 目录补入后端 `PATH`，由 Main、子智能体和命令继承。仅含系统目录时，工具目录前置；已有自定义顺序则保留，在末尾补充缺项。不执行 shell 配置或猜测版本管理器目录。终端 CLI 使用调用方环境。

## 连接存储与兼容

App 使用 Electron safeStorage 加密客户端会话凭据，保存在桌面数据目录的 `client-sessions.json`；系统授权失败时显示错误，重试不会覆盖已保存凭据。模型和搜索密钥属于所选执行主机。

独立执行主机把模型与搜索密钥保存在配置文件旁的 `credentials.json`（0600，可用 `COWORK_CREDENTIALS` 指定路径）。设置接口只返回 `configured`、`credentialUnavailable` 或 `secretUnavailable` 及具体 `credentialError`，不返回密钥；空白密钥保留原值，显式清除搜索密钥会删除保存项。旧桌面密文在迁移前按不可用处理，不会被报告为已配置。

旧 Electron 加密配置的一次性转换：先停止后端，再在仓库内运行 `node scripts/migrate-desktop-settings.mjs --config <模型配置文件>`（可选 `--credentials`、`--legacy-secret`；隔离验证可用 `--host-arg --use-mock-keychain` 避免访问真实钥匙串）。工具临时调用旧宿主解密全部值后才写入，先把原文件备份为 `<配置>.before-host-credentials`，再原子改写配置；失败时原文件、备份和凭据文件都不变，成功后原配置中的密文和明文密钥被移除。重跑返回 `already-migrated`，不会新增连接。迁移完成后重新启动后端；正在运行的后端不会重新读取磁盘配置。设置页和真实运行使用同一份主机凭据，密钥不会进入界面状态、日志或事件。

旧单组连接显示为“默认配置”。首次保存多组配置前创建 `.before-model-profiles` 备份，并保留旧桌面 `model-secret.bin`；未知版本拒绝覆盖。恢复备份前先退出应用，配置和备份均按私有数据管理。

客户端会话使用独立钥匙串进程的 `CoworkOS Client` 加密标识；旧模型密文转换仍使用 `Atria` 标识。旧开发标识加密的密钥可能需要重新输入，原密文与源目录保留。原生钥匙串和签名兼容需单独验收。

## 角色模型

`roleModels` 只在执行主机的本地配置中保存角色绑定；连接和密钥仍由 `modelConnections` 与主机凭据管理。

```json
{
  "roleModels": {
    "version": 1,
    "host": { "main": { "profileId": "<连接 ID>" } },
    "projects": { "project_<uuid>": { "main": { "profileId": "<连接 ID>" } } }
  }
}
```

- `host` 是本机所有项目的角色默认；`projects` 是按共享项目稳定 ID 索引的本机覆盖。两者都不进入共享项目数据，其他后端不会继承。
- 解析优先级为单次/会话显式选择、当前执行主机的项目覆盖、主机角色默认、现有启用连接。旧 Task 的显式 `model` 仍在没有连接组时作为回退，连接切换与推理参数语义不变。
- 每次 Run 在准入时固定连接、模型、消息格式与推理参数，并把非敏感来源记录为 `main.run_spawned.modelSelection`；之后修改设置只影响下一次 Run，在途 Run 和原请求重试继续使用已保存的执行归属。
- 已保存的角色引用找不到连接时给出包含角色、范围和连接 ID 的错误，并拒绝启动，不会改用其他账号。保存接口拒绝新建失效引用。
- P3 只接通 Main；`executor`、`reviewer`、`router` 是可复用配置键，但不会由运行路径读取，UI 也不显示为已生效。

## 独立视觉连接

`modelConnections.visionId` 指向已保存且启用 `supportsImages` 的连接。原生图像模型直接接收像素；只有纯文本模型调用 `read_image` 时使用独立视觉连接。界面操作见 [模型连接](configuration.md#app-与-web-模型连接)。

CLI 环境设置需同时提供 `COWORK_VISION_API_BASE`、`COWORK_VISION_API_KEY` 和 `COWORK_VISION_MODEL`。完整设置优先于保存的视觉连接，缺项时报错。

| 可选变量                                  | 含义与默认值                                |
| ----------------------------------------- | ------------------------------------------- |
| `COWORK_VISION_MODEL_API`                 | 视觉连接的消息格式                          |
| `COWORK_VISION_THINKING_FORMAT`           | 视觉连接的思考格式                          |
| `COWORK_VISION_MAX_TOKENS`                | 默认 8192；范围 1 至 65536，审阅时最多 8192 |
| `COWORK_VISION_REASONING_EFFORT`          | 默认 `off`                                  |
| `COWORK_VISION_SUPPORTS_REASONING_EFFORT` | 默认 `false`                                |

可信子进程继承所选连接，密钥不进入界面或队列；凭据仍使用原有加密或私有 JSON 存储。

## 联网搜索

无显式设置时使用 Exa。已有 `serperApiKey`、`COWORK_SERPER_API_KEY` 或 `SERPER_API_KEY` 时保留 Serper；显式 `webSearch.provider`（`exa` / `serper` / `off`）优先于凭据推断。旧 `webTools: false` 和 `COWORK_WEB_TOOLS=0` 关闭搜索，环境关闭优先。`COWORK_WEB_TOOLS=1` 可覆盖旧布尔关闭，但不能覆盖明确的 `provider: "off"`。升级不写回已有选择。

自有 Exa 密钥可用 `webSearch.exaApiKey` 或 `COWORK_EXA_API_KEY` / `EXA_API_KEY`，环境变量优先。Serper 仍需自己的密钥。Main、子智能体和恢复会话使用同一搜索配置。

默认连接 [Exa 官方托管 MCP](https://exa.ai/docs/get-started/exa-mcp)：`https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa`。仅启用基础搜索和读取，支持 JSON/SSE、会话及协议头、取消与 30 秒总期限。`COWORK_EXA_MCP_ENDPOINT` 仅用于可信测试服务，界面不提供地址输入。

工具保留来源的标题、URL、正文和可用日期，缺失日期不补造。单 URL 读取需有效来源及非空正文，并保留重定向后的 URL；多来源需匹配请求 URL。无效来源、空结构、仅元数据或无法关联的正文均算工具失败，供应商 JSON 包装不作为网页证据。只有服务返回真实空列表才算零结果；网络、代理、协议、超时及取消均为失败。

## 网络代理

| JSON 字段    | 环境变量                      |
| ------------ | ----------------------------- |
| `httpProxy`  | `HTTP_PROXY` / `http_proxy`   |
| `httpsProxy` | `HTTPS_PROXY` / `https_proxy` |
| `noProxy`    | `NO_PROXY` / `no_proxy`       |

环境变量优先。代理地址仅接受 HTTP(S) URL，例如 `http://proxy.example:8080`。`localhost`、`127.0.0.1` 和 `::1` 始终加入绕过列表，其余条目保留。

设置适用于 CLI Main、headless CLI、子智能体、模型发现、连接测试和独立视觉请求，支持两种模型协议。会话、视觉分析和测试在结束或取消后释放自己的代理连接。交互 Pi 使用 SDK 环境代理；没有模型或视觉专用代理变量。带认证的代理地址属于私有配置。

## 项目数据存储

项目台账与共享项目身份保存在独立的项目数据服务中：个人部署默认使用本机 SQLite，也可显式选择 PostgreSQL。两种模式共用同一领域服务、HTTP 接口和 Main 工具，业务行为不随引擎变化。引擎在服务启动时确定；配置无效、数据库不可达或认证失败会直接报错并指出引擎与目标，不切换到另一引擎，也不以空库继续运行。

```json
{
  "projectData": {
    "engine": "postgres",
    "postgres": { "connectionString": "postgresql://coworkos@db.example:5432/coworkos" }
  }
}
```

其他后端不打开本地引擎，而是经认证客户端访问同一权威服务：

```json
{
  "projectData": {
    "authority": { "url": "http://127.0.0.1:3880", "token": "本机凭据" }
  }
}
```

`authority` 与 `engine`、`sqlite`、`postgres` 互斥。客户端启动时用主机凭据换取一个本地会话，之后只出示该会话；凭据保存在服务端配置或 `COWORK_PROJECT_DATA_TOKEN`，不进入界面、工具参数或错误文本。权威服务不可达返回 `storage_unavailable`，会话被撤销返回 `shared_auth_failed`；两者都不伪造认领成功，也不自动转移归属。主会话记录与看板一样经该客户端共享；Task、Pi 历史与执行归属仍留在创建它的后端，另一个后端不能为不属于自己的会话记录或结算 Run。共享项目沿用同一 `projectId`，每个后端只登记自己的本机目录绑定；远端绝对路径不会成为本机执行目录。备份与恢复在权威服务所在后端执行，远程客户端会明确拒绝。

SQLite 的默认文件是数据根下的 `project-data.sqlite`（`ATRIA_HOME/runtime/project-data.sqlite`，默认 `~/.atria/runtime/project-data.sqlite`）；`projectData.sqlite.path` 可指定文件，相对路径按数据根解析。PostgreSQL 也可用 `host`、`port`、`database`、`user`、`password`、`ssl` 分开填写。连接凭据只保存在服务端配置或 `COWORK_PROJECT_DATA_URL`，不进入界面、工具参数或错误文本。

选择引擎与既有数据迁移是两件事：更换引擎不会移动已有项目目录索引、Task/Run、附件或 Pi 历史，本阶段也不做跨引擎自动搬迁、双写或运行中热切换。既有项目目录索引继续提供稳定 `projectId`；共享项目记录只保存身份，本机目录作为当前后端的绑定单独保存，共享记录中的目录不会被当作本机执行目录。

### 备份与恢复

服务启动时按版本执行 schema 迁移。`GET /api/project-data` 报告当前引擎、服务端版本和已应用的 schema 版本；`target` 是文件路径或 `postgresql://host:port/database`，不含凭据。备份与恢复使用同一服务，按当前引擎读取和写入：

```sh
coworkos data backup --to ~/backups/project-data.json
coworkos data restore --from ~/backups/project-data.json
```

备份是本机逻辑快照（文件权限 0600），包含共享项目、本机目录绑定、需求、修订、决定、引用、看板条目与事件、Main 会话与运行归属；Pi 历史不在快照里，仍由执行后端本地保管。恢复在一个事务里按外键顺序整体替换这些记录，并拒绝来自另一引擎或旧 schema 的备份文件。恢复前先停止写入该数据根的后端，恢复后重启后端读取。使用 `projectData.authority` 的后端没有本地数据库，备份和恢复在权威服务所在后端执行。

## 外部 Main 容量

external 服务的外部 Main 配额写在本机配置中；未配置时保持原有内部用法，并拒绝创建 external 会话。`resident` 为正整数，`continuation` 为非负整数，两者上限 32；非法值在读取配置时报错，不猜测默认值。

```json
{ "mainCapacity": { "resident": 2, "continuation": 1 } }
```

`resident` 限制同时运行的外部常规 Main，`continuation` 保留给接续 Main，二者不能互相借用；内部 Main 不占外部配额。每个项目可保存的外部常规会话数等于 `resident`，保存但未运行不占运行名额，接续会话不计入项目常规上限。降低配额若低于正在运行的数量或任何项目已保存的常规会话数会被拒绝并说明原因，已有运行不会被终止。

配额与容量状态经 `GET /api/main-capacity` 读取、`POST /api/main-capacity` 修改；运行与排队事实保存在数据根的 `main-capacity/state.json`（默认 `~/.atria/runtime/main-capacity/state.json`），随本机后端身份，不写入共享项目数据。程序按到达顺序占用空闲名额，进程结束、启动失败、取消、崩溃和重启对账都会释放名额并推进队列；重启只核对本机自有进程，不终止无关进程。共享服务暂时不可达等可恢复故障会释放名额但保留已接受的需求，按退避重试并在容量视图显示等待/失败状态与最近错误；不可自动恢复的永久拒绝同样保留输入，直接记为失败而不消耗重试。失败的需求仍保留输入，可由 `POST /api/main-capacity` 的 `retry` 操作重新排队。被派发的 Main 在开始工作前会把自己的进程号登记到名额；启动对账会短暂等待该登记再释放无 pid 的预留，名额已被释放的 Main 拒绝启动。CLI 与 main-worker 启动 external Main 时读取同一文件并写入同一队列；排队中的需求只保留显式 profile/model/推理选择，默认连接在真正获得名额时按角色配置解析，因此在等待期间修改的 host/项目默认作用于这次 Run。

接口说明见 [Product API](product-api.md#external-main-capacity)。

## 路径与环境变量

| 环境变量                                              | 用途                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `COWORK_CONFIG`                                       | 显式配置文件                                                          |
| `COWORK_API_BASE` / `COWORK_MODEL` / `COWORK_API_KEY` | 模型地址、ID、密钥                                                    |
| `COWORK_MODEL_API`                                    | 与 `api` 取值相同                                                     |
| `COWORK_THINKING_FORMAT`                              | 当前进程的思考格式                                                    |
| `COWORK_SUPPORTS_IMAGES`                              | `1` / `true` 开启，`0` / `false` 关闭                                 |
| `COWORK_REASONING_EFFORT`                             | 推理强度                                                              |
| `COWORK_SUPPORTS_REASONING_EFFORT`                    | `1` / `true` 开启，`0` / `false` 禁止强度字段                         |
| `COWORK_SUPPORTS_PROMPT_CACHE_KEY`                    | `1` / `true` 开启，`0` / `false` 关闭第三方缓存键                     |
| `ATRIA_HOME`                                          | App、CLI、Web 用户目录，默认 `~/.atria`；显式路径覆盖仍优先           |
| `COWORK_DESKTOP_DATA`                                 | 独立桌面数据目录                                                      |
| `COWORK_WORKSPACE`                                    | 持久任务数据目录，默认 `~/.atria/workspace`                           |
| `COWORK_PROJECT_DIR`                                  | Main 文件与命令的项目目录                                             |
| `PI_CODING_AGENT_DIR`                                 | Pi 状态目录，默认 `~/.atria/pi`                                       |
| `COWORK_TASK_ID`                                      | 固定 Main Task，恢复时配合原 Pi 会话                                  |
| `COWORK_UI_PORT`                                      | 源码 Web 端口，默认 3880                                              |
| `COWORK_PROJECT_DATA_ENGINE`                          | 项目数据引擎：`sqlite`（默认）或 `postgres`                           |
| `COWORK_PROJECT_DATA_SQLITE`                          | SQLite 数据文件路径                                                   |
| `COWORK_PROJECT_DATA_URL`                             | PostgreSQL 连接地址，覆盖配置文件中的 `projectData.postgres`          |
| `COWORK_PROJECT_DATA_AUTHORITY`                       | 共享项目数据权威服务地址，覆盖 `projectData.authority.url`            |
| `COWORK_PROJECT_DATA_TOKEN`                           | 权威服务访问凭据，覆盖 `projectData.authority.token`                  |
| `COWORK_TRUSTED_CLIENT_ORIGINS`                       | 受信本机页面来源，逗号分隔的精确 `http://127.0.0.1:<port>` 等回环地址 |

`COWORK_TRUSTED_CLIENT_ORIGINS` 只接受精确的本机 `http://` 来源，不接受通配符；命名的来源可以跨端口读取该后端的响应并出现在其页面 `connect-src` 中。真实请求仍走凭据校验，监听地址仍为 `127.0.0.1`。浏览器页面管理另一个本机后端时，两者需要互相命名对方来源。详见 [Product API](product-api.md#trusted-local-client-origins)。

各入口运行状态默认位于 `~/.atria/runtime`。项目设置保存 `projectName`、`projectId`、`projectDirectory`，首条消息才创建会话。项目工作目录与 `workspaceRoot` / `COWORK_WORKSPACE` 下的内部存储相互独立。

显式旧 `.tmp` / `.tmp/pi-agent` 路径继续生效，源码入口不再隐式使用仓库 `.tmp`。App 正式版与开发版共用数据及单实例锁。`COWORK_DESKTOP_DATA` 和 `ATRIA_HOME` 显式覆盖会跳过旧桌面数据自动复制；空的默认桌面目录会复制对应旧配置，保留来源。

`coworkos data paths` 显示实际路径。已有目录可用 `coworkos data import --from PATH --kind desktop --name old-app` 导入其他桌面数据，源码工作区用 `--kind workspace`。导入保留来源，拒绝重复名称，并在历史目录中登记独立工作区。详见 [持久数据布局](task-workspace-layout.md)。

## 界面语言

在“设置 → 通用 → 语言”选择“简体中文”或“English”，默认简体中文。切换前会保存应用文档、检查冲突并保存会话与人工回复草稿；无法安全保存时保留当前界面。切换后刷新页面生效。

Web 将偏好按站点保存在 `localStorage` 的 `atria.language`；App 将偏好保存在用户数据目录的 `language.json`，不受本地后端随机端口影响。此设置用于共用 App/Web 主界面、设置、会话和工作台操作；不修改已有用户内容、模型回复语言、CLI、系统原生弹窗或第三方嵌入编辑器的独立语言设置。后端和外部工具返回的原始错误保留原文。

## 外观存储

App 将外观偏好保存在用户数据目录的 `appearance.json`，Web 按浏览器站点保存。App 缺失或无效偏好使用“跟随系统”；Web 缺失或无效偏好使用深色，浏览器存储不可用时回退为“跟随系统”。已有手动选择保留。浅色模式保留星云、星空与多智能体星系；系统高对比度下隐藏装饰画布。

## 高级运行限制

下表为底层 Runtime 默认值；文件和环境覆盖优先。新连接的输出上限为 8192，推理设置为 `off` / `false`，已有连接不自动改写。

| JSON 字段                   | 环境变量                              | Runtime 默认值                                   |
| --------------------------- | ------------------------------------- | ------------------------------------------------ |
| `mainMaxTurns`              | `COWORK_MAIN_MAX_TURNS`               | 2000                                             |
| `subagentMaxTurns`          | `COWORK_MAX_TURNS`                    | 200                                              |
| `mainMaxTokens`             | `COWORK_MAIN_MAX_TOKENS`              | 65536；新连接 8192                               |
| `subagentMaxTokens`         | `COWORK_MAX_TOKENS`                   | 65536；新连接 8192                               |
| `contextWindow`             | `COWORK_CONTEXT_WINDOW`               | 256000 token                                     |
| `mainTimeoutMs`             | `COWORK_MAIN_TIMEOUT_MS`              | 0，不限时                                        |
| `subagentTimeoutMs`         | `COWORK_SUBAGENT_TIMEOUT_MS`          | 0，不限时；旧 `COWORK_TIMEOUT_MS` 仅兼容子智能体 |
| `commandTimeoutMs`          | `COWORK_COMMAND_TIMEOUT_MS`           | 1800000（30 分钟）；0 不限时                     |
| `maxAttempts`               | `COWORK_MAX_ATTEMPTS`                 | 3，含首次委派；1 关闭委派重试                    |
| `subagentQuestionTimeoutMs` | `COWORK_SUBAGENT_QUESTION_TIMEOUT_MS` | 180000（3 分钟）；0 关闭向 Main 提问             |
| `humanAnswerTimeoutMs`      | `COWORK_HUMAN_ANSWER_TIMEOUT_MS`      | 60000（1 分钟）                                  |
| `subagentMaxQuestions`      | `COWORK_SUBAGENT_MAX_QUESTIONS`       | 3                                                |

超时单位为毫秒。`maxAttempts` 是委派预算，独立于模型请求重试。长任务与重试行为见 [运行时参考](runtime-reference.md#请求重试与上下文恢复)。

实现：[配置读取](../src/runtime/config.ts)、[运行设置](../src/runtime/runtime-settings.ts)、[连接参数](../src/runtime/model-profile.ts)。回归：[CLI 配置](../test/cli-onboarding.test.js)、[模型协议](../test/model-protocol.test.js)。
