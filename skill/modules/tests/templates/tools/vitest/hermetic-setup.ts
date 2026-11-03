// Vitest global setup: runs once per run in the main process, before any test worker starts, so
// no module under test can read a real credential or write to the real home directory. Workers
// inherit the scrubbed environment. The teardown deletes the temporary home.
//
// Names listed in HERMETIC_KEEP_ENV (comma-separated) survive the scrub, for a test that needs one.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(?:^|_)(?:API_?)?KEYS?(?:_|$)/i;

type Env = Record<string, string | undefined>;

/** Deletes every variable whose name looks like it holds a secret, except the kept ones; returns the deleted names. */
export function scrubSecretEnv(env: Env, keep: string[] = []): string[] {
  const removed = Object.keys(env).filter((name) => SECRET_NAME.test(name) && !keep.includes(name));
  for (const name of removed) delete env[name];
  return removed.sort();
}

/** Points HOME and the XDG base directories into `home`, creating them. */
export function isolateHome(env: Env, home: string): void {
  const dirs = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
  };
  for (const [name, dir] of Object.entries(dirs)) {
    mkdirSync(dir, { recursive: true });
    env[name] = dir;
  }
}

/** Scrubs `env`, moves its home into a new temporary directory and returns the teardown. */
export function startHermeticRun(env: Env): { home: string; removed: string[]; teardown: () => void } {
  const keep = (env.HERMETIC_KEEP_ENV ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const home = mkdtempSync(join(tmpdir(), "vitest-home-"));
  const removed = scrubSecretEnv(env, keep);
  isolateHome(env, home);
  return { home, removed, teardown: () => rmSync(home, { recursive: true, force: true }) };
}

export default function setup(): () => void {
  return startHermeticRun(process.env).teardown;
}
