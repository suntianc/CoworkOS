/**
 * Providers people commonly add, with the address and wire format each one's
 * documentation names. A preset only fills the add-provider form and picks the
 * logo; every field stays editable and the backend stores plain values.
 *
 * Logos come from lobehub/lobe-icons (MIT), see THIRD_PARTY_NOTICES.md. A mono
 * logo is drawn in the text color so it reads in both themes. An international
 * endpoint of a Chinese vendor names the vendor's logo with `logo`.
 */
export const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    region: "cn",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    keyUrl: "https://platform.deepseek.com/api_keys"
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    region: "cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys"
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    region: "cn",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    mono: true,
    keyUrl: "https://platform.moonshot.cn/console/api-keys"
  },
  {
    id: "bailian",
    name: "阿里云百炼",
    region: "cn",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1"
  },
  {
    id: "volcengine",
    name: "火山方舟",
    region: "cn",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey"
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    region: "cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    keyUrl: "https://cloud.siliconflow.cn/account/ak"
  },
  {
    id: "minimax",
    name: "MiniMax",
    region: "cn",
    baseUrl: "https://api.minimaxi.com/v1",
    api: "openai-completions",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key"
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    region: "cn",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    api: "openai-completions"
  },
  {
    id: "qianfan",
    name: "百度千帆",
    region: "cn",
    baseUrl: "https://qianfan.baidubce.com/v2",
    api: "openai-completions",
    keyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list"
  },
  {
    id: "xiaomimimo",
    name: "小米 MiMo",
    region: "cn",
    baseUrl: "https://api.xiaomimimo.com/v1",
    api: "openai-completions",
    mono: true
  },
  {
    id: "spark",
    name: "讯飞星火",
    region: "cn",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    api: "openai-completions",
    keyUrl: "https://console.xfyun.cn/services/cbm"
  },
  {
    id: "openai",
    name: "OpenAI",
    region: "global",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    mono: true,
    keyUrl: "https://platform.openai.com/api-keys"
  },
  {
    id: "anthropic",
    name: "Anthropic",
    region: "global",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    mono: true,
    keyUrl: "https://console.anthropic.com/settings/keys"
  },
  {
    id: "gemini",
    name: "Google Gemini",
    region: "global",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: "openai-completions",
    keyUrl: "https://aistudio.google.com/apikey"
  },
  {
    id: "xai",
    name: "xAI",
    region: "global",
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions",
    mono: true,
    keyUrl: "https://console.x.ai"
  },
  {
    id: "mistral",
    name: "Mistral",
    region: "global",
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    keyUrl: "https://console.mistral.ai/api-keys"
  },
  {
    id: "groq",
    name: "Groq",
    region: "global",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    mono: true,
    keyUrl: "https://console.groq.com/keys"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    region: "global",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    mono: true,
    keyUrl: "https://openrouter.ai/keys"
  },
  {
    id: "together",
    name: "Together AI",
    region: "global",
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions",
    keyUrl: "https://api.together.ai/settings/api-keys"
  },
  {
    id: "fireworks",
    name: "Fireworks",
    region: "global",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
    keyUrl: "https://fireworks.ai/account/api-keys"
  },
  {
    id: "zai",
    name: "Z.ai",
    region: "global",
    baseUrl: "https://api.z.ai/api/paas/v4",
    api: "openai-completions",
    mono: true,
    keyUrl: "https://z.ai/manage-apikey/apikey-list"
  },
  {
    id: "moonshot-global",
    logo: "moonshot",
    name: "Kimi Global",
    region: "global",
    baseUrl: "https://api.moonshot.ai/v1",
    api: "openai-completions",
    mono: true,
    keyUrl: "https://platform.moonshot.ai/console/api-keys"
  },
  {
    id: "alibabacloud",
    name: "Alibaba Cloud",
    region: "global",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key"
  },
  {
    id: "byteplus",
    name: "BytePlus",
    region: "global",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    api: "openai-completions",
    keyUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey"
  },
  {
    id: "siliconflow-global",
    logo: "siliconflow",
    name: "SiliconFlow",
    region: "global",
    baseUrl: "https://api.siliconflow.com/v1",
    api: "openai-completions",
    keyUrl: "https://cloud.siliconflow.com/account/ak"
  },
  {
    id: "minimax-global",
    logo: "minimax",
    name: "MiniMax Global",
    region: "global",
    baseUrl: "https://api.minimax.io/v1",
    api: "openai-completions",
    keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key"
  },
  {
    id: "hunyuan-global",
    logo: "hunyuan",
    name: "Hunyuan Global",
    region: "global",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
    api: "openai-completions"
  },
  {
    id: "ollama",
    name: "Ollama",
    region: "local",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    mono: true,
    apiKey: "ollama"
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    region: "local",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    mono: true,
    apiKey: "lm-studio"
  }
];

export const PRESET_REGIONS = [
  ["cn", "中国"],
  ["global", "国际"],
  ["local", "本地与自定义"]
];

export const presetById = (id) => PROVIDER_PRESETS.find((preset) => preset.id === id);
