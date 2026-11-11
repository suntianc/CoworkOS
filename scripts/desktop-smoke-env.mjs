import { join } from "node:path";

/** Keep the packaged smoke on its own data/model directories without changing the caller. */
export function desktopSmokeEnvironment({ data, source = process.env }) {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !/^(?:ATRIA_|COWORK_|PI_|CSC_|APPLE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|SERPER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(
          name
        ) && !/_API_KEY$/.test(name)
    )
  );
  return {
    ...env,
    PATH: "/usr/bin:/bin",
    FORMICAND_DESKTOP_BACKGROUND: source.FORMICAND_DESKTOP_BACKGROUND ?? "1",
    ATRIA_HOME: data,
    COWORK_DESKTOP_DATA: data,
    PI_CODING_AGENT_DIR: join(data, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  };
}
