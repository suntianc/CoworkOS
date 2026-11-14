import js from "@eslint/js";
import path from "node:path";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Pi dependency boundary (spec rule 8): only `import type` may reach a Pi
 * package from anywhere. Runtime imports belong to the modules that own the Pi
 * process, and package-internal subpaths belong to model configuration only.
 * Keep this list explicit and in sync with docs/architecture.md.
 */
export const piDependencyBoundary = {
  runtimeDirectories: [".pi/", "scripts/"],
  runtimeModules: {
    // 模型配置：连接探测、思考档位、模型参数与请求记录。
    modelConfiguration: [
      "src/runtime/main-request-retry.ts",
      "src/runtime/model-cache.ts",
      "src/runtime/model-connection.ts",
      "src/runtime/model-levels.ts",
      "src/runtime/model-profile.ts",
      "src/runtime/model-provider.ts",
      "src/runtime/model-request-recording.ts"
    ],
    // Main 会话文件读写：后端在 Main 未运行时改写 Pi 会话文件。
    mainSessionFiles: ["src/runtime/conversation-fork.ts", "src/runtime/main-message-edit.ts"],
    // 临时例外：上下文压缩重新设计后收回，届时删除本列表。
    contextCompaction: ["src/runtime/compaction-summary-guard.ts", "src/runtime/compaction-summary-policy.ts"]
  }
};

const piRuntimeDirectories = piDependencyBoundary.runtimeDirectories;
const piModelConfigModules = new Set(piDependencyBoundary.runtimeModules.modelConfiguration);
const piRuntimeModules = new Set(Object.values(piDependencyBoundary.runtimeModules).flat());

const piImportBoundary = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep Pi runtime and package-internal imports inside the modules that own them."
    },
    schema: [],
    messages: {
      runtimeImport:
        "Pi runtime imports are only allowed in .pi/, scripts/, the model configuration modules, the Main session file write modules and the context compaction modules. Use `import type` or move this import into an allowed module.",
      deepImport:
        "Pi package subpaths may only be imported by model configuration modules. Import from the package entry point instead."
    }
  },
  create(context) {
    const filename = path.relative(context.cwd, context.filename).split(path.sep).join("/");
    const inRuntimeDirectory = piRuntimeDirectories.some((directory) => filename.startsWith(directory));

    /** Import specifiers shared by every statement form; type-only imports are unrestricted. */
    const check = (node, specifier, typeOnly) => {
      if (typeOnly || typeof specifier !== "string" || !specifier.startsWith("@earendil-works/pi-")) return;
      const subpath = specifier.slice("@earendil-works/pi-".length);
      // The package name ends at the first slash; anything after it is a package-internal path.
      if (subpath.includes("/")) {
        if (!piModelConfigModules.has(filename)) context.report({ node, messageId: "deepImport" });
        return;
      }
      if (!inRuntimeDirectory && !piRuntimeModules.has(filename)) {
        context.report({ node, messageId: "runtimeImport" });
      }
    };
    const literalValue = (node) =>
      node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
    const allSpecifiersAreTypes = (specifiers) =>
      specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type");

    return {
      ImportDeclaration(node) {
        check(
          node.source,
          node.source.value,
          node.importKind === "type" || allSpecifiersAreTypes(node.specifiers)
        );
      },
      ExportNamedDeclaration(node) {
        if (!node.source) return;
        check(
          node.source,
          node.source.value,
          node.exportKind === "type" ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((specifier) => specifier.exportKind === "type"))
        );
      },
      ExportAllDeclaration(node) {
        check(node.source, node.source.value, node.exportKind === "type");
      },
      ImportExpression(node) {
        check(node, literalValue(node.source), false);
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "require") return;
        if (node.arguments.length !== 1) return;
        check(node, literalValue(node.arguments[0]), false);
      }
    };
  }
};

const discardedErrors = [
  {
    selector: "CatchClause[param=null]:not(:has(ThrowStatement))",
    message: "catch discards the error without rethrowing. Handle or rethrow it."
  },
  {
    selector: "CatchClause[param!=null] > BlockStatement.body[body.length=0]",
    message: "Empty catch swallows the error. Handle or rethrow it."
  },
  {
    selector:
      "CallExpression[callee.property.name='catch'][arguments.length=1] > :function.arguments[params.length=0]:not(:has(ThrowStatement))",
    message: ".catch() callback discards the rejection. Handle or propagate it."
  },
  {
    selector:
      "CallExpression[callee.property.name='catch'][arguments.length=1] > :function.arguments[params.length>0][body.type='BlockStatement'][body.body.length=0]",
    message: "Empty .catch() callback swallows the rejection. Handle or propagate it."
  }
];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "web/assets/cad/generated/**",
      "web/assets/pptist/generated/**",
      "web/assets/math/generated/**",
      "web/assets/mermaid/generated/**",
      "web/assets/markdown/generated/**",
      "release/**",
      ".tmp/**",
      "agents/**",
      "test-results/**"
    ]
  },
  {
    files: ["web/**/*.js", "desktop/**/*.cjs", "scripts/**/*.mjs", "e2e/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["src/**/*.ts", ".pi/**/*.ts"],
    languageOptions: { parser: tseslint.parser, globals: globals.node },
    rules: {
      "no-debugger": "error",
      "no-constant-condition": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "@typescript-eslint/no-explicit-any": "error"
    },
    plugins: { "@typescript-eslint": tseslint.plugin }
  },
  {
    files: ["src/**/*.ts", ".pi/**/*.ts"],
    languageOptions: {
      parserOptions: { project: "./tsconfig.extensions.json", tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-useless-catch": "error"
    }
  },
  {
    files: ["src/**/*.ts", ".pi/**/*.ts", "web/**/*.js", "desktop/**/*.cjs", "scripts/**/*.mjs"],
    rules: { "no-restricted-syntax": ["error", ...discardedErrors] }
  },
  {
    files: ["src/dashboard/*routes.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: ["node:child_process", "../runtime/process-host.js"], patterns: ["**/cli/**"] }
      ]
    }
  },
  {
    files: ["src/dashboard/run-service.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: ["node:http", "./http.js"], patterns: ["**/cli/**"] }]
    }
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/cli/**", "src/dashboard/*routes.ts", "src/dashboard/run-service.ts", "src/gui/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/cli/**"] }]
    }
  },
  {
    files: ["src/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/cli/**", "**/dashboard/**"] }]
    }
  },
  {
    files: [".pi/extensions/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: ["../../src/**", "../../dist/**"] }] }
  },
  {
    files: ["src/gui/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/dashboard/**", "**/cli/**"] }]
    }
  },
  {
    files: ["src/**/*.ts", ".pi/**/*.ts", "scripts/**/*.mjs", "web/**/*.js", "desktop/**/*.cjs"],
    plugins: { cowork: { rules: { "pi-import-boundary": piImportBoundary } } },
    rules: { "cowork/pi-import-boundary": "error" }
  },
  {
    files: [
      "src/dashboard/**/*.ts",
      "src/gui/**/*.ts",
      "src/security/**/*.ts",
      ".pi/runtime/**/*.ts",
      "desktop/**/*.cjs",
      "web/assets/controllers/**/*.js"
    ],
    rules: { "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }] }
  }
];
