import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

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
    files: ["src/runtime/**/*.ts", "src/applications/**/*.ts"],
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
      "no-restricted-imports": ["error", { patterns: ["**/applications/**", "**/dashboard/**", "**/cli/**"] }]
    }
  },
  {
    files: [
      "src/dashboard/**/*.ts",
      "src/software/**/*.ts",
      "src/gui/**/*.ts",
      "src/security/**/*.ts",
      ".pi/runtime/**/*.ts",
      "desktop/**/*.cjs",
      "web/assets/controllers/**/*.js"
    ],
    rules: { "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }] }
  }
];
