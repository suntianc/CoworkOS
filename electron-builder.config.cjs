/** Signing is explicit; signing/notarization and installation still have separate release gates. */
const signingConfigured = Boolean(process.env.CSC_NAME?.trim());
module.exports = {
  appId: "org.atria.cowork",
  productName: "CoworkOS",
  directories: { output: ".tmp/release" },
  extraMetadata: { main: "desktop/main.cjs" },
  // Pi loads TypeScript extensions and spawns scripts by real path.
  asar: false,
  npmRebuild: false,
  forceCodeSigning: signingConfigured,
  electronDist: "node_modules/electron/dist",
  files: [
    "desktop/**/*.cjs",
    "dist/src/**/*",
    "dist/cli-ui-manifest.json",
    "dist/scripts/data-home.cjs",
    "dist/web/assets/agent-names.js",
    "web/**/*",
    ".pi/extensions/**/*",
    ".pi/runtime/**/*",
    ".pi/prompts/**/*",
    ".pi/skills/**/*",
    "scripts/start-pi.mjs",
    "scripts/start-pi-runtime.mjs",
    "scripts/cli-runtime-host.mjs",
    "scripts/cli-information.mjs",
    "scripts/cli-startup-error.mjs",
    "scripts/cli-ui-compatibility.mjs",
    "scripts/cli-ui-policy.json",
    "scripts/cli-ui-boot.mjs",
    "scripts/cli-shell-policy.json",
    "scripts/cli-shell-compatibility.mjs",
    "scripts/cli-shell-boot.mjs",
    "docs/cli-ui-adapter.md",
    "docs/en/cli-ui-adapter.md",
    "scripts/data-home.cjs",
    "scripts/science.mjs",
    "scripts/data-migration.cjs",
    "scripts/cli-session.mjs",
    "scripts/cli-session-export.mjs",
    "scripts/cli-session-picker.mjs",
    "scripts/cli-branding.mjs",
    "scripts/file-search.mjs",
    "scripts/search-tool-adapter.mjs",
    "scripts/read-attachment.py",
    "scripts/main-session.mjs",
    "scripts/main-worker.mjs",
    "scripts/update-release.mjs",
    "scripts/update-npm-desktop.mjs",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses/**/*",
    "vendor/sciagentgym/**/*",
    "!**/*.map",
    "!**/*.tsbuildinfo",
    "!node_modules/**/test{,s}/**",
    "!node_modules/**/example{,s}/**",
    "!**/.DS_Store"
  ],
  extraResources: [
    { from: "node_modules/electron/dist/LICENSE", to: "licenses/electron/LICENSE" },
    {
      from: "node_modules/electron/dist/LICENSES.chromium.html",
      to: "licenses/electron/LICENSES.chromium.html"
    }
  ],
  mac: {
    icon: "build/atria.icns",
    minimumSystemVersion: "14.0",
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.productivity",
    entitlements: "desktop/entitlements.mac.plist",
    entitlementsInherit: "desktop/entitlements.mac.plist",
    extendInfo: {
      NSMicrophoneUsageDescription: "CoworkOS 在你点击语音输入后使用麦克风，将语音转成当前对话的文字草稿。",
      NSSpeechRecognitionUsageDescription:
        "CoworkOS 使用 macOS 语音识别生成文字草稿；系统可能通过 Apple 服务处理语音。"
    },
    ...(signingConfigured ? {} : { identity: null })
  },
  dmg: {
    title: "CoworkOS 内测版",
    contents: [
      { x: 150, y: 180 },
      { x: 430, y: 180, type: "link", path: "/Applications" }
    ]
  },
  artifactName: "CoworkOS-${version}-mac-${arch}.${ext}",
  publish: null
};
