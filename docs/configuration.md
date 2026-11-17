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

打开“设置 → 模型与角色”。页面有“供应商”和“角色分配”两页；除角色分配外，修改供应商和模型前要先结束运行中的任务。

1. 点击“添加供应商”，从“中国 / 国际 / 本地与自定义”中选一家。预置供应商已填好 API 地址和接口格式，只需填写 API Key；其他兼容 OpenAI 或 Anthropic 接口的服务选“自定义”，填写名称、API 地址并选择接口格式（Chat Completions、Responses 或 Anthropic Messages）。
2. 点击“添加并获取模型”。App 读取服务商的模型列表，勾选要用的模型后点击“加入模型”；服务商不提供列表时关闭弹窗，点击“手动添加”填写模型 ID。
3. 在供应商详情点击“检查”，用第一个模型验证连接与工具调用。检查会消耗少量额度。
4. 模型行的参数按钮打开该模型的上下文窗口、输出上限、推理档位与图片输入。标“自动”的值来自服务商接口或内置目录，手动修改后以填写的为准。

API 地址只填域名时自动补 `/v1`，带路径的地址原样使用。供应商详情里改了名称、地址、密钥或接口格式后，点击底部的“保存”生效，或点“放弃”还原；未保存的修改在切换供应商时保留。

“角色分配”为 Main、Executor、Reviewer 各选一个模型，下拉按供应商分组；Main 还可为当前项目单独覆盖。未选择时 Main 使用第一个启用供应商的第一个模型，Executor、Reviewer 沿用启动它们的 Run 的模型。推理强度属于所选模型，在角色行旁调整。角色设置对之后启动的 Run 生效；正在运行的 Run 保持启动时固定的模型和推理参数。Main 在每次 Run 准入时读取角色配置；Executor、Reviewer 在每次委派工作项实际启动时读取，所以修改只影响之后启动的工作项。切换模型会保留会话，下一轮会将历史发送给新服务。正被角色使用的模型或供应商不能移除或停用，先在角色分配中改选。

密钥由执行主机保存，界面只显示是否已配置；存储位置和失败处理见[连接存储与兼容](configuration-reference.md#连接存储与兼容)，配置结构见[模型供应商](configuration-reference.md#模型供应商)。

## 连接失败

| 情况                      | 处理                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 401 / 403，认证或权限错误 | 核对 API Key、模型 ID 和账号的模型访问权限。                                                                                            |
| 404，地址或模型不存在     | 按服务商文档核对 API 根地址与模型 ID；移除地址末尾的 `/responses` 或 `/chat/completions`。                                              |
| 不支持消息格式或参数      | 改用服务支持的接口格式（Chat Completions、Responses 或 Anthropic Messages）；关闭服务未声明支持的图像、推理或缓存参数。                 |
| CLI 显示 `FAIL 模型配置`  | 按 `doctor` 打印的路径修正 JSON 和必填字段；尚无配置时运行 `coworkos init`。更多错误见 [CLI 排错](installation-reference.md#常见问题)。 |
| CLI 修改文件后仍用旧值    | 检查 `COWORK_API_BASE`、`COWORK_MODEL`、`COWORK_API_KEY`、`COWORK_MODEL_API`；环境变量优先于文件，移除不再使用的覆盖项后重试。          |
| App 保存失败              | 按提示处理保存错误后再次点击保存；未保存的修改会保留。                                                                                  |

修正后重新检查。App 在供应商详情点击“检查”；CLI 重新运行 `coworkos doctor --test-connection`。

<details>
<summary>其他配置参考</summary>

- [图像、推理、上下文与输出上限](configuration-reference.md#模型参数) · [图片输入](configuration-reference.md#图片输入)
- [CLI 文件优先级与自动化初始化](configuration-reference.md#cli-配置文件) · [连接存储与兼容](configuration-reference.md#连接存储与兼容)
- <a id="app-与-web-项目文件夹"></a>[项目目录与内部数据](task-workspace-layout.md#项目与任务路径)
- [界面语言](configuration-reference.md#界面语言)
- <a id="外观"></a>[外观](configuration-reference.md#外观存储)
- <a id="联网搜索"></a>[联网搜索](configuration-reference.md#联网搜索)
- <a id="网络代理"></a>[网络代理](configuration-reference.md#网络代理)
- <a id="路径与常用环境变量"></a>[路径与环境变量](configuration-reference.md#路径与环境变量)
- <a id="高级运行限制"></a>[运行限制](configuration-reference.md#高级运行限制)

</details>
