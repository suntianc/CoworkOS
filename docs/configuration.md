# 模型设置

简体中文 | [English](en/configuration.md)

## 最小连接配置

先从模型服务商取得 API 地址、模型 ID 和 API Key，并确认支持哪种消息格式。

| 连接信息 | 填写内容                                                   |
| -------- | ---------------------------------------------------------- |
| API 地址 | 服务根地址或 `/v1`，例如 `https://your-service.example/v1` |
| 模型     | 服务商提供、当前账号可调用的模型 ID                        |
| API Key  | 当前服务的密钥                                             |
| 消息格式 | 新连接默认 Responses；也可选择 Chat Completions            |

服务需要支持所选格式的流式响应和工具调用。API 地址不要填完整的 `/responses` 或 `/chat/completions` 路径，也不能包含用户名、密码、查询参数或片段。原生 Anthropic 接口不能直接使用。

## CLI 配置文件与环境变量

首次使用时，在准备工作的项目目录运行 `coworkos init`，依次输入地址、模型 ID 和密钥。完整安装流程见 [CLI 快速开始](cli-quickstart.md)。

### 修改地址、模型或密钥

先退出 CLI 的交互界面，在准备工作的项目目录运行：

```sh
coworkos doctor
```

查看输出开头的“配置路径”。默认是 `~/.atria/config.json`；如果显示其他路径，编辑显示的那份文件。

```sh
nano ~/.atria/config.json
```

在原文件中修改对应字段，保留其他设置。下面的地址、模型和密钥都要替换为服务商提供的值：

```json
{
  "baseUrl": "https://your-service.example/v1",
  "model": "your-model-id",
  "apiKey": "replace-with-your-api-key",
  "api": "openai-responses"
}
```

`init` 新建的连接默认使用 Responses。服务商只支持 Chat Completions 时，将 `api` 改为 `"openai-completions"`。`init` 不会询问这个选项。

在 nano 中按 Ctrl+O、Enter 保存，再按 Ctrl+X 退出。若之前用 `export COWORK_MODEL_API=...` 临时切换过格式，先运行 `unset COWORK_MODEL_API`，让文件中的 `api` 生效。

### 检查修改

```sh
coworkos doctor --test-connection
```

所有检查通过、模型连接项显示 `OK  流式模型连接与工具调用` 后，重新运行 `coworkos`，或用 `coworkos --continue` 继续原会话。连接测试会请求模型并消耗服务额度；不加 `--test-connection` 的 `doctor` 只检查本机环境和配置。

## App 与 Web 模型连接

先结束运行中的任务，再打开“设置 → 模型连接”。

1. 在“已保存的配置”选择已有连接，或点击“＋ 新增配置”。
2. 填写配置名称、模型 ID、API 地址、消息格式和 API Key。已有连接的密钥留空会保留原密钥；新连接必须填写。
3. 点击“测试连接”，检查当前表单。测试会消耗模型额度，通过后仍需保存。
4. 首组连接点击“保存连接”后自动启用。切换到其他连接时点击“保存并启用”；只保存备用连接时点击“保存连接”。

修改当前启用的连接并保存后，后续消息使用新设置。切换服务会保留会话，下一轮会将历史发送给新服务。

密钥由执行主机保存，界面只显示是否已配置；存储位置、旧桌面配置的一次性转换和失败处理见[连接存储与兼容](configuration-reference.md#连接存储与兼容)。

## 连接失败

| 情况                      | 处理                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 401 / 403，认证或权限错误 | 核对 API Key、模型 ID 和账号的模型访问权限。                                                                                            |
| 404，地址或模型不存在     | 按服务商文档核对 API 根地址与模型 ID；移除地址末尾的 `/responses` 或 `/chat/completions`。                                              |
| 不支持消息格式或参数      | 使用服务支持的 Responses / Chat Completions；关闭服务未声明支持的图像、推理或缓存参数。                                                 |
| CLI 显示 `FAIL 模型配置`  | 按 `doctor` 打印的路径修正 JSON 和必填字段；尚无配置时运行 `coworkos init`。更多错误见 [CLI 排错](installation-reference.md#常见问题)。 |
| CLI 修改文件后仍用旧值    | 检查 `COWORK_API_BASE`、`COWORK_MODEL`、`COWORK_API_KEY`、`COWORK_MODEL_API`；环境变量优先于文件，移除不再使用的覆盖项后重试。          |
| App 显示“保存未完成”      | 按提示处理保存错误；若弹出 macOS 钥匙串授权，完成授权后再次点击保存。取消授权时，原配置与表单会保留。                                   |

修正后重新测试。App 测试通过后保存连接；CLI 重新运行 `coworkos doctor --test-connection`。

<details>
<summary>其他配置参考</summary>

- [图像、推理、上下文与输出上限](configuration-reference.md#模型参数) · [独立视觉连接](configuration-reference.md#独立视觉连接)
- [CLI 文件优先级与自动化初始化](configuration-reference.md#cli-配置文件) · [连接存储与兼容](configuration-reference.md#连接存储与兼容)
- <a id="app-与-web-项目文件夹"></a>[项目目录与内部数据](task-workspace-layout.md#项目应用资源与任务路径)
- [界面语言](configuration-reference.md#界面语言)
- <a id="外观"></a>[外观](configuration-reference.md#外观存储)
- <a id="联网搜索"></a>[联网搜索](configuration-reference.md#联网搜索)
- <a id="网络代理"></a>[网络代理](configuration-reference.md#网络代理)
- <a id="路径与常用环境变量"></a>[路径与环境变量](configuration-reference.md#路径与环境变量)
- <a id="高级运行限制"></a>[运行限制](configuration-reference.md#高级运行限制)

</details>
