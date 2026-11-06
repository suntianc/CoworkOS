# Model settings

[简体中文](../configuration.md) | English

## Connection fields

Get the API URL, model ID and API key from your provider, and check which message format the service supports.

| Field          | What to enter                                                                |
| -------------- | ---------------------------------------------------------------------------- |
| API URL        | A service root or `/v1`, such as `https://your-service.example/v1`           |
| Model          | A provider model ID available to your account                                |
| API Key        | The service's key                                                            |
| Message format | Responses by default for new connections; Chat Completions is also available |

The service must support streaming and tool calls in the selected format. Do not enter the full `/responses` or `/chat/completions` path. URLs cannot contain credentials, query parameters or fragments. Native Anthropic endpoints cannot be used directly.

## CLI files and environment variables

For first-time setup, run `coworkos init` in your project folder and enter the URL, model ID and key when prompted. See the [CLI quickstart](cli-quickstart.md) for the full installation flow.

### Change the URL, model or key

Exit the CLI's interactive interface, then run this in the project folder where you plan to work:

```sh
coworkos doctor
```

Read “配置路径” (configuration path) near the top of the output. The default is `~/.atria/config.json`. If another path is shown, edit that file instead.

```sh
nano ~/.atria/config.json
```

Update the matching fields in the existing file and keep its other settings. Replace the example URL, model and key with your provider's values:

```json
{
  "baseUrl": "https://your-service.example/v1",
  "model": "your-model-id",
  "apiKey": "replace-with-your-api-key",
  "api": "openai-responses"
}
```

New connections created by `init` use Responses. For a service that only supports Chat Completions, change `api` to `"openai-completions"`. `init` does not prompt for this choice.

In nano, press Ctrl+O, then Enter to save, and Ctrl+X to exit. If you previously used `export COWORK_MODEL_API=...` to change the format temporarily, run `unset COWORK_MODEL_API` so the file's `api` value takes effect.

### Check the change

```sh
coworkos doctor --test-connection
```

After all checks pass and the model connection line reads `OK  流式模型连接与工具调用` (streaming connection and tool calls), run `coworkos` again, or `coworkos --continue` to return to the previous conversation. The connection test requests the model and uses service quota. Without `--test-connection`, `doctor` only checks local requirements and configuration.

## App and Web model connections

Stop running tasks, then open Settings → Model connections.

1. Choose a saved connection or select “＋ 新增配置” (Add configuration).
2. Enter the configuration name, model ID, API URL, message format and API key. A blank key preserves an existing connection's key; a new connection requires one.
3. Select Test connection to check the current form. The test uses model quota; you still need to save afterward.
4. Save connection activates the first connection automatically. Select Save and enable to switch to another connection, or Save connection to keep it for later.

Saving changes to the active connection applies them to subsequent messages. Switching services preserves conversations; the next turn sends the history to the new service.

The execution host stores keys and the UI only shows whether a connection is configured. See [connection storage](configuration-reference.md#connection-storage-and-compatibility) for the location, one-time conversion of an old desktop configuration and failure handling.

## Connection errors

| Symptom                                          | Action                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 / 403, authentication or access error        | Check the API key, model ID and your account's model access.                                                                                                                                             |
| 404, URL or model not found                      | Check the API root and model ID against the provider's documentation; remove a trailing `/responses` or `/chat/completions` from the URL.                                                                |
| Unsupported message format or parameter          | Use the service's supported Responses / Chat Completions format; disable image, reasoning or cache parameters that the provider does not support.                                                        |
| CLI reports `FAIL 模型配置`                      | Fix the JSON and required fields at the path printed by `doctor`. Run `coworkos init` if no configuration exists. See [CLI troubleshooting](installation-reference.md#troubleshooting) for other errors. |
| CLI still uses old values after editing the file | Check `COWORK_API_BASE`, `COWORK_MODEL`, `COWORK_API_KEY` and `COWORK_MODEL_API`. Environment variables override the file; remove obsolete overrides and retry.                                          |
| App reports “保存未完成” (Save incomplete)       | Follow the save error. If macOS requests Keychain authorization, authorize it and select Save again. Canceling preserves the previous configuration and form.                                            |

Test again after fixing the error. In the App, save after the test passes. In the CLI, rerun `coworkos doctor --test-connection`.

<details>
<summary>Other configuration references</summary>

- [Images, reasoning, context and output limits](configuration-reference.md#model-parameters) · [Separate vision connection](configuration-reference.md#separate-vision-connection)
- [CLI file precedence and automated setup](configuration-reference.md#cli-files) · [Connection storage and compatibility](configuration-reference.md#connection-storage-and-compatibility)
- <a id="app-and-web-project-folders"></a>[Project folders and internal data](../task-workspace-layout.md#项目应用资源与任务路径) (Chinese)
- [Interface language](configuration-reference.md#interface-language)
- <a id="appearance"></a>[Appearance](configuration-reference.md#appearance-storage)
- <a id="web-search"></a>[Web search](configuration-reference.md#web-search)
- <a id="scientific-environments"></a>[Scientific environments](scientific-tools.md)
- <a id="network-proxies"></a>[Network proxies](configuration-reference.md#network-proxies)
- <a id="paths-and-common-environment-variables"></a>[Paths and environment variables](configuration-reference.md#paths-and-environment-variables)
- <a id="advanced-limits"></a>[Runtime limits](configuration-reference.md#advanced-limits)

</details>
