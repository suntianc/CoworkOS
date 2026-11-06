import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";

test("packaged smoke excludes inherited data/model/credential overrides while leaving caller HOME intact", () => {
  const source = {
    HOME: "/fixture/original-home",
    TMPDIR: "/fixture/tmp",
    PATH: "/fixture/node/bin",
    ATRIA_HOME: "/fixture/not-the-smoke",
    ATRIA_DESKTOP_APP: "/fixture/not-the-candidate",
    ATRIA_COMPONENTS_HOME: "/fixture/not-the-components",
    ATRIA_COMPONENTS_RELEASE_ROOT: "https://fixture.invalid/not-the-release",
    ATRIA_COMPONENTS_GITHUB_TOKEN: "fixture-only-component-token",
    COWORK_CONFIG: "/fixture/not-the-config",
    COWORK_API_KEY: "fixture-only-key",
    COWORK_BLENDER_EXECUTABLE: "/fixture/not-the-runtime",
    PI_CODING_AGENT_DIR: "/fixture/not-the-pi",
    PI_MODEL: "fixture-not-the-model",
    OPENAI_API_KEY: "fixture-only-provider",
    ANTHROPIC_AUTH_TOKEN: "fixture-only-token",
    GOOGLE_API_KEY: "fixture-only-speech-key",
    OTHER_API_KEY: "fixture-only-other-key",
    AWS_SHARED_CREDENTIALS_FILE: "/fixture/not-the-credentials",
    CSC_LINK: "fixture-only-certificate",
    APPLE_KEYCHAIN_PROFILE: "fixture-only-profile",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "fixture-only-node-options"
  };
  const original = { ...source };
  const env = desktopSmokeEnvironment({ data: "/fixture/owned-data", source });
  assert.deepEqual(source, original);
  assert.deepEqual(env, {
    HOME: "/fixture/original-home",
    TMPDIR: "/fixture/tmp",
    PATH: "/usr/bin:/bin",
    ATRIA_HOME: "/fixture/owned-data",
    COWORK_DESKTOP_DATA: "/fixture/owned-data",
    PI_CODING_AGENT_DIR: "/fixture/owned-data/pi",
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  });
});
