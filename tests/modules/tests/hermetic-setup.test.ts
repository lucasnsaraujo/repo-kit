import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isolateHome,
  scrubSecretEnv,
  startHermeticRun,
} from "../../../skills/repo-kit/modules/tests/templates/tools/vitest/hermetic-setup.ts";
import { removeTempDirs, tempDir } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

describe("scrubSecretEnv", () => {
  test("removes variables whose names look like credentials and keeps the rest", () => {
    const env: Record<string, string | undefined> = {
      GH_TOKEN: "x",
      NODE_AUTH_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_ACCESS_KEY_ID: "x",
      OPENAI_API_KEY: "x",
      STRIPE_KEY: "x",
      DB_PASSWORD: "x",
      GOOGLE_APPLICATION_CREDENTIALS: "/path",
      SSH_PRIVATE_KEY_PATH: "/path",
      PATH: "/usr/bin",
      KEYBOARD_LAYOUT: "us",
      MONKEY: "x",
      NODE_ENV: "test",
    };
    expect(scrubSecretEnv(env)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "DB_PASSWORD",
      "GH_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "NODE_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "SSH_PRIVATE_KEY_PATH",
      "STRIPE_KEY",
    ]);
    expect(env).toEqual({ PATH: "/usr/bin", KEYBOARD_LAYOUT: "us", MONKEY: "x", NODE_ENV: "test" });
  });

  test("keeps the names it is told to keep", () => {
    const env: Record<string, string | undefined> = { GH_TOKEN: "x", NPM_TOKEN: "y" };
    scrubSecretEnv(env, ["NPM_TOKEN"]);
    expect(env).toEqual({ NPM_TOKEN: "y" });
  });
});

test("isolateHome points HOME and the XDG directories inside the given home and creates them", () => {
  const home = tempDir();
  const env: Record<string, string | undefined> = { HOME: "/Users/real" };
  isolateHome(env, home);
  expect(env.HOME).toBe(home);
  expect(env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
  expect(env.XDG_STATE_HOME).toBe(join(home, ".local/state"));
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    expect(statSync(env[name] ?? "").isDirectory()).toBe(true);
  }
});

test("a hermetic run honours HERMETIC_KEEP_ENV and its teardown deletes the temporary home", () => {
  const env: Record<string, string | undefined> = {
    HOME: "/Users/real",
    GH_TOKEN: "x",
    NPM_TOKEN: "y",
    HERMETIC_KEEP_ENV: "NPM_TOKEN, OTHER",
  };
  const run = startHermeticRun(env);
  expect(run.removed).toEqual(["GH_TOKEN"]);
  expect(env.NPM_TOKEN).toBe("y");
  expect(env.HOME).toBe(run.home);
  expect(existsSync(run.home)).toBe(true);
  run.teardown();
  expect(existsSync(run.home)).toBe(false);
});
