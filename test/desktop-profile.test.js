import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
const { desktopProfile } = createRequire(import.meta.url)("../desktop/profile.cjs");

test("source, Finder development and release apps share one user home and instance lock", () => {
  const source = desktopProfile({ isPackaged: false, appRoot: "/checkout", env: {} });
  const finder = desktopProfile({
    isPackaged: true,
    appRoot: "/dev-bootstrap",
    env: {
      COWORK_DESKTOP_DEV: "1",
      COWORK_DESKTOP_SOURCE_ROOT: "/checkout"
    }
  });
  assert.deepEqual(source, finder);
  assert.equal(source.name, "CoworkOS Dev");
  assert.equal(source.userData, join(homedir(), ".atria"));
  const release = desktopProfile({
    isPackaged: true,
    appRoot: "/release",
    env: { COWORK_DESKTOP_SOURCE_ROOT: "/checkout" }
  });
  assert.equal(release.name, "CoworkOS");
  assert.equal(source.encryptionName, release.encryptionName);
  assert.equal(release.encryptionName, "Atria");
  assert.equal(release.userData, source.userData);
  assert.equal(release.appRoot, "/release");
});

test("ATRIA_HOME moves release and development together, while explicit desktop test data wins", () => {
  const base = { appRoot: "/checkout" };
  assert.equal(
    desktopProfile({ ...base, isPackaged: true, env: { ATRIA_HOME: "/shared" } }).userData,
    "/shared"
  );
  assert.equal(
    desktopProfile({ ...base, isPackaged: false, env: { ATRIA_HOME: "/shared" } }).userData,
    "/shared"
  );
  assert.equal(
    desktopProfile({
      ...base,
      isPackaged: false,
      env: { ATRIA_HOME: "/shared", COWORK_DESKTOP_DATA: "/fixture" }
    }).userData,
    "/fixture"
  );
});

test("explicit desktop data overrides remain available to isolated native tests", () => {
  const profile = desktopProfile({
    isPackaged: false,
    appRoot: "/checkout",
    env: { COWORK_DESKTOP_DATA: "/fixture" }
  });
  assert.equal(profile.userData, "/fixture");
});
