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

Open Settings → Models and roles. The page has two tabs, Providers and Role assignment. Stop running tasks before changing providers or models; role assignment may change at any time.

1. Select Add provider and pick one from China, International or Local and custom. A preset fills in the API address and wire format, so you only enter the API key. For any other service that speaks the OpenAI or Anthropic API, choose Custom, enter a name and the API address, and pick the format (Chat Completions, Responses or Anthropic Messages).
2. Select Add and fetch models. The App reads the provider's model list; tick the models you want and select Add models. If the provider offers no list, close the dialog and use Add manually with the model ID.
3. Select Check in the provider's detail to verify the connection and tool calls with its first model. A check uses a little quota.
4. A model row's settings button opens its context window, output limits, reasoning levels and image input. Values marked Auto come from the provider's listing or the built-in catalog; a value you edit wins from then on.

A bare host address gets `/v1`; an address with a path is used as written. After changing a provider's name, address, key or format, select Save at the bottom, or Discard to revert; unsaved edits survive switching to another provider.

Role assignment picks one model each for Main, Executor and Reviewer from a list grouped by provider, and Main can be overridden for the current project. Without a choice Main uses the first model of the first enabled provider, and Executor and Reviewer keep the model of the Run that started them. Reasoning effort belongs to the chosen model and is adjusted beside the role. Role changes apply to Runs started afterward; a running Run keeps the model and reasoning it was admitted with. Switching models preserves conversations; the next turn sends the history to the new service. A model or provider that a role uses cannot be removed or disabled until the role picks another.

The execution host stores keys and the UI only shows whether a provider is configured. See [connection storage](configuration-reference.md#connection-storage-and-compatibility) for the location and failure handling, and [model providers](configuration-reference.md#model-providers) for the configuration shape.

## Connection errors

| Symptom                                          | Action                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 / 403, authentication or access error        | Check the API key, model ID and your account's model access.                                                                                                                                             |
| 404, URL or model not found                      | Check the API root and model ID against the provider's documentation; remove a trailing `/responses` or `/chat/completions` from the URL.                                                                |
| Unsupported message format or parameter          | Switch to the format the service supports (Chat Completions, Responses or Anthropic Messages); disable image, reasoning or cache parameters that the provider does not support.                          |
| CLI reports `FAIL 模型配置`                      | Fix the JSON and required fields at the path printed by `doctor`. Run `coworkos init` if no configuration exists. See [CLI troubleshooting](installation-reference.md#troubleshooting) for other errors. |
| CLI still uses old values after editing the file | Check `COWORK_API_BASE`, `COWORK_MODEL`, `COWORK_API_KEY` and `COWORK_MODEL_API`. Environment variables override the file; remove obsolete overrides and retry.                                          |
| App save fails                                   | Follow the save error and select Save again; unsaved edits are kept.                                                                                                                                     |

Check again after fixing the error. In the App, select Check in the provider's detail. In the CLI, rerun `coworkos doctor --test-connection`.

<details>
<summary>Other configuration references</summary>

- [Images, reasoning, context and output limits](configuration-reference.md#model-parameters) · [Image input](configuration-reference.md#image-input)
- [CLI file precedence and automated setup](configuration-reference.md#cli-files) · [Connection storage and compatibility](configuration-reference.md#connection-storage-and-compatibility)
- <a id="app-and-web-project-folders"></a>[Project folders and internal data](../task-workspace-layout.md#项目与任务路径) (Chinese)
- [Interface language](configuration-reference.md#interface-language)
- <a id="appearance"></a>[Appearance](configuration-reference.md#appearance-storage)
- <a id="web-search"></a>[Web search](configuration-reference.md#web-search)
- <a id="network-proxies"></a>[Network proxies](configuration-reference.md#network-proxies)
- <a id="paths-and-common-environment-variables"></a>[Paths and environment variables](configuration-reference.md#paths-and-environment-variables)
- <a id="advanced-limits"></a>[Runtime limits](configuration-reference.md#advanced-limits)

</details>
