type Option = {
  kind: "text" | "id" | "boolean" | "integer";
  min?: number;
  max?: number;
  choices?: readonly string[];
};
type Command = { usage: string; options: Record<string, Option>; actions?: Record<string, Command> };
const text: Option = { kind: "text" };
const identifier: Option = { kind: "id" };
const boolean: Option = { kind: "boolean" };
const positive: Option = { kind: "integer", min: 1 };
const milliseconds: Option = { kind: "integer", min: 1, max: 2147483647 };
const workspace = { workspace: text, "workspace-root": text };
const model = {
  "reasoning-effort": { kind: "text", choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  thinking: { kind: "text", choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  "max-turns": positive,
  "max-tokens": { kind: "integer", min: 1, max: 65536 },
  timeout: { kind: "integer", min: 0, max: 2147483647 }
} satisfies Record<string, Option>;

const commands: Record<string, Command> = {
  task: {
    usage: "coworkos task list|create|status|cancel|resume|complete [options]",
    options: {},
    actions: {
      list: { usage: "coworkos task list [--workspace PATH]", options: workspace },
      create: {
        usage: "coworkos task create ID [GOAL] [--goal TEXT] [--workspace PATH]",
        options: { ...workspace, task: identifier, goal: text }
      },
      status: {
        usage: "coworkos task status ID [--workspace PATH]",
        options: { ...workspace, task: identifier }
      },
      cancel: {
        usage: "coworkos task cancel ID [--workspace PATH]",
        options: { ...workspace, task: identifier }
      },
      resume: {
        usage: "coworkos task resume ID [--workspace PATH]",
        options: { ...workspace, task: identifier }
      },
      complete: {
        usage: "coworkos task complete ID [--workspace PATH]",
        options: { ...workspace, task: identifier }
      }
    }
  },
  human: {
    usage: "coworkos human list|reply|answer|cancel --task ID [options]",
    options: {},
    actions: {
      list: {
        usage: "coworkos human list --task ID [--status pending|answered|cancelled|unanswered]",
        options: {
          ...workspace,
          task: identifier,
          status: { kind: "text", choices: ["pending", "answered", "cancelled", "unanswered"] }
        }
      },
      reply: {
        usage: "coworkos human reply REQUEST ANSWER --task ID [--request ID] [--answer TEXT]",
        options: { ...workspace, task: identifier, request: identifier, answer: text }
      },
      answer: {
        usage: "coworkos human answer REQUEST ANSWER --task ID [--request ID] [--answer TEXT]",
        options: { ...workspace, task: identifier, request: identifier, answer: text }
      },
      cancel: {
        usage: "coworkos human cancel REQUEST --task ID [--request ID]",
        options: { ...workspace, task: identifier, request: identifier }
      }
    }
  },
  single: {
    usage: "coworkos single PROMPT [--task ID] [--run ID] [--resume] [--workspace PATH]",
    options: { ...workspace, ...model, task: identifier, run: identifier, resume: boolean }
  },
  worker: {
    usage: "coworkos worker --task ID --run ID [--once] [--max-attempts N] [--lease-ms N] [--poll-ms N]",
    options: {
      ...workspace,
      ...model,
      task: identifier,
      run: identifier,
      once: boolean,
      "max-attempts": positive,
      "lease-ms": milliseconds,
      "poll-ms": milliseconds
    }
  },
  "main-supervisor": {
    usage: "coworkos main-supervisor [--task ID] [--interval MS] [--once] [--spawn]",
    options: { ...workspace, task: identifier, interval: milliseconds, once: boolean, spawn: boolean }
  },
  "main-worker": {
    usage: "coworkos main-worker --task ID [--workspace PATH] [--poll-ms N] [--once] (internal wake worker)",
    options: { workspace: text, task: identifier, "poll-ms": milliseconds, once: boolean }
  }
};

export function cliHelp(command?: string, action?: string): string {
  const definition = command ? commands[command] : undefined;
  const selected = action ? definition?.actions?.[action] : definition;
  if (!selected)
    return `CoworkOS CLI\n\n${Object.values(commands)
      .map((item) => `  ${item.usage}`)
      .join("\n")}\n\nUse coworkos COMMAND --help for options.`;
  const options = selected.actions
    ? Object.values(selected.actions)
        .map((item) => `  ${item.usage}`)
        .join("\n")
    : Object.entries(selected.options)
        .map(
          ([name, option]) =>
            `  --${name}${option.kind === "boolean" ? " [true|false]" : ` ${option.choices?.join("|") || (option.kind === "integer" ? "N" : "VALUE")}`}`
        )
        .join("\n");
  return `CoworkOS CLI\n\nUsage: ${selected.usage}\n\n${options}\n  -h, --help  Show help without changing configuration or tasks.\n\nModel commands use the configured connection. --timeout is in milliseconds; 0 means unlimited.\nUse -- before prompt or answer text that starts with a dash.`;
}

export function parseCliCommand(command: string, input: string[]) {
  const definition = commands[command];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- command 来自 argv，命令表里没有该键时查表结果为 undefined
  if (!definition) throw new Error(`Unknown command: ${command}. Run coworkos --help.`);
  const allowed = {
    ...definition.options,
    ...Object.assign({}, ...Object.values(definition.actions || {}).map((action) => action.options))
  } as Record<string, Option>;
  const positionals: string[] = [];
  const options: Record<string, string | undefined> = {};
  let help = false;
  let endOptions = false;
  for (let index = 0; index < input.length; index++) {
    const argument = input[index];
    if (argument === "--" && !endOptions) {
      endOptions = true;
      continue;
    }
    if (endOptions || !argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    if (["--help", "-h"].includes(argument)) {
      help = true;
      continue;
    }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    const name = match?.[1];
    const option = name ? allowed[name] : undefined;
    if (!name || !option) throw new Error(`Unknown option: ${argument}. Run coworkos ${command} --help.`);
    // The `=value` group is optional in the pattern, so it can be absent at runtime.
    let value = match[2];
    if (option.kind === "boolean") {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 可选分组 `(?:=(.*))?` 未参与匹配时该位置为 undefined，类型却按 string 声明
      if (value === undefined && ["true", "false"].includes(input[index + 1])) value = input[++index];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上：`--flag` 不带 `=value` 时分组缺失，默认取 true
      value ??= "true";
      if (!["true", "false"].includes(value)) throw new Error(`--${name} requires true or false.`);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上：`--opt` 不带 `=value` 时分组缺失，必须读取下一个 argv 元素
      if (value === undefined) {
        value = input[++index];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- argv 在该位置可能没有下一个元素，越界读取得到 undefined
        if (value === undefined || value.startsWith("--") || value === "-h")
          throw new Error(`--${name} requires a value.`);
      }
      if (!value.trim()) throw new Error(`--${name} requires a non-empty value.`);
      if (option.kind === "integer") {
        const number = Number(value);
        if (
          !Number.isSafeInteger(number) ||
          number < (option.min ?? 0) ||
          number > (option.max ?? Number.MAX_SAFE_INTEGER)
        )
          throw new Error(
            `--${name} requires an integer ${option.min === 0 ? "at least 0" : "at least 1"}${option.max ? ` and at most ${option.max}` : ""}.`
          );
      }
      if (option.kind === "id") validateId(value, `--${name}`);
      if (option.choices && !option.choices.includes(value))
        throw new Error(`--${name} requires ${option.choices.join("|")}.`);
    }
    options[name] = value;
  }
  const action = definition.actions ? positionals[0] : undefined;
  if (action && !definition.actions?.[action])
    throw new Error(`Unknown ${command} action: ${action}. Run coworkos ${command} --help.`);
  const selected = action ? definition.actions![action] : definition;
  for (const name of Object.keys(options)) {
    if (!(name in selected.options) && (!help || action))
      throw new Error(`--${name} is not valid for ${command}${action ? ` ${action}` : ""}.`);
  }
  if (!help) validateOperands(command, action, positionals, options);
  return { positionals, options, help, action };
}

function validateId(value: string, label: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || [".", ".."].includes(value))
    throw new Error(`${label} requires an ID containing letters, digits, '.', '_' or '-'.`);
}

function validateOperands(
  command: string,
  action: string | undefined,
  positionals: string[],
  options: Record<string, string | undefined>
) {
  const operands = action ? positionals.slice(1) : positionals;
  const requireOptions = (...names: string[]) => {
    for (const name of names)
      if (!options[name]) throw new Error(`${command}${action ? ` ${action}` : ""} requires --${name}.`);
  };
  const noExtra = (count = 0) => {
    if (operands.length > count)
      throw new Error(
        `Unexpected argument for ${command}${action ? ` ${action}` : ""}. Run coworkos ${command} --help.`
      );
  };
  if (["task", "human"].includes(command) && !action)
    throw new Error(`Choose a ${command} action. Run coworkos ${command} --help.`);
  if (command === "task") {
    if (action === "list") return noExtra();
    const taskId = operands[0] ?? options.task;
    if (!taskId) throw new Error("task requires a task ID.");
    validateId(taskId, "task");
    if (action !== "create" || options.goal) noExtra(options.task && !operands.length ? 0 : 1);
  } else if (command === "human") {
    requireOptions("task");
    if (action === "list") return noExtra();
    const requestId = options.request ?? operands[0];
    if (!requestId) throw new Error("human requires a request ID.");
    validateId(requestId, "request");
    if (action === "cancel" || options.answer) noExtra(options.request ? 0 : 1);
    if (action !== "cancel" && !options.answer && operands.length < (options.request ? 1 : 2))
      throw new Error("human reply requires an answer.");
  } else if (command === "single") {
    if (!operands.length) throw new Error("single requires a prompt.");
  } else {
    noExtra();
    if (command === "worker") requireOptions("task", "run");
  }
}
