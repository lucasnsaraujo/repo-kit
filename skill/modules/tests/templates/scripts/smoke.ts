// End-to-end smoke: starts the app, waits until its health URL answers, runs the HTTP checks in
// scripts/smoke.config.json and writes .artifacts/smoke.json. Exits 1 when the app never became
// healthy or any check failed.
//
//   node scripts/smoke.ts [--config=path/to/smoke.config.json]
//
// The wait polls the health URL and stops early when the app process exits, so a crash fails in
// seconds instead of at the timeout.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type SmokeCheck = { name: string; url: string; method: string; status: number; bodyIncludes: string | null };

export type SmokeConfig = {
  start: string;
  env: Record<string, string>;
  healthUrl: string;
  startTimeoutMs: number;
  checks: SmokeCheck[];
};

type CheckResult = {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
};

type SmokeReport = {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  start: { command: string; ready: boolean; readyMs: number | null; error: string | null };
  checks: CheckResult[];
  appOutputTail: string[];
};

const POLL_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_LINES = 50;

function fail(message: string): never {
  throw new Error(`smoke config: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") fail(`${where}.${key} must be a non-empty string`);
  return value;
}

export function parseSmokeConfig(raw: unknown): SmokeConfig {
  if (!isRecord(raw)) fail("must be a JSON object");
  const env = raw.env ?? {};
  if (!isRecord(env) || !Object.values(env).every((value) => typeof value === "string"))
    fail("env must map names to strings");
  const timeout = raw.startTimeoutMs ?? 60_000;
  if (typeof timeout !== "number" || timeout <= 0) fail("startTimeoutMs must be a positive number");
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) fail("checks must list at least one check");

  const checks = raw.checks.map((check: unknown, index): SmokeCheck => {
    const where = `checks[${index}]`;
    if (!isRecord(check)) fail(`${where} must be an object`);
    const status = check.status ?? 200;
    if (typeof status !== "number") fail(`${where}.status must be a number`);
    const bodyIncludes = check.bodyIncludes ?? null;
    if (bodyIncludes !== null && typeof bodyIncludes !== "string") fail(`${where}.bodyIncludes must be a string`);
    const method = check.method ?? "GET";
    if (typeof method !== "string") fail(`${where}.method must be a string`);
    return {
      name: readString(check, "name", where),
      url: readString(check, "url", where),
      method,
      status,
      bodyIncludes,
    };
  });

  return {
    start: readString(raw, "start", "config"),
    env: Object.fromEntries(Object.entries(env).map(([name, value]) => [name, String(value)])),
    healthUrl: readString(raw, "healthUrl", "config"),
    startTimeoutMs: timeout,
    checks,
  };
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Resolves once `url` answers 2xx; rejects when `exited` settles first or the timeout passes. */
async function waitForHealthy(url: string, timeoutMs: number, exited: Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exitReason: string | null = null;
  void exited.then((reason) => {
    exitReason = reason;
  });
  while (Date.now() < deadline) {
    if (await answers(url)) return;
    if (exitReason !== null) throw new Error(`the app exited before ${url} answered: ${exitReason}`);
    await Promise.race([delay(POLL_INTERVAL_MS, undefined, { ref: false }), exited]);
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms`);
}

async function runCheck(check: SmokeCheck): Promise<CheckResult> {
  const started = Date.now();
  const result = (ok: boolean, status: number | null, error: string | null): CheckResult => ({
    name: check.name,
    url: check.url,
    ok,
    status,
    durationMs: Date.now() - started,
    error,
  });
  try {
    const response = await fetch(check.url, { method: check.method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await response.text();
    if (response.status !== check.status)
      return result(false, response.status, `expected status ${check.status}, got ${response.status}`);
    if (check.bodyIncludes !== null && !body.includes(check.bodyIncludes)) {
      return result(false, response.status, `body does not include ${JSON.stringify(check.bodyIncludes)}`);
    }
    return result(true, response.status, null);
  } catch (error) {
    return result(false, null, error instanceof Error ? error.message : String(error));
  }
}

function startApp(config: SmokeConfig, cwd: string, output: string[]): { app: ChildProcess; exited: Promise<string> } {
  const app = spawn(config.start, { cwd, shell: true, detached: true, env: { ...process.env, ...config.env } });
  const keep = (chunk: Buffer) => {
    output.push(...chunk.toString("utf8").split("\n").filter(Boolean));
    output.splice(0, Math.max(0, output.length - OUTPUT_TAIL_LINES));
  };
  app.stdout?.on("data", keep);
  app.stderr?.on("data", keep);
  const exited = new Promise<string>((resolveExit) => {
    app.once("error", (error) => resolveExit(error.message));
    app.once("exit", (code, signal) => resolveExit(signal ? `signal ${signal}` : `exit code ${code}`));
  });
  return { app, exited };
}

/** Stops the app's whole process group, so a shell wrapper does not leave the server running. */
async function stopApp(app: ChildProcess, exited: Promise<string>): Promise<void> {
  const pid = app.pid;
  if (app.exitCode !== null || app.signalCode !== null || pid === undefined) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      app.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), delay(5_000, false, { ref: false })]);
  if (!stopped) signalGroup("SIGKILL");
}

export async function runSmoke(config: SmokeConfig, cwd: string): Promise<SmokeReport> {
  const startedAt = new Date();
  const output: string[] = [];
  const { app, exited } = startApp(config, cwd, output);
  const start: SmokeReport["start"] = { command: config.start, ready: false, readyMs: null, error: null };
  const checks: CheckResult[] = [];
  try {
    await waitForHealthy(config.healthUrl, config.startTimeoutMs, exited);
    start.ready = true;
    start.readyMs = Date.now() - startedAt.getTime();
    for (const check of config.checks) checks.push(await runCheck(check));
  } catch (error) {
    start.error = error instanceof Error ? error.message : String(error);
  } finally {
    await stopApp(app, exited);
  }
  return {
    ok: start.ready && checks.every((check) => check.ok),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    start,
    checks,
    appOutputTail: [...output],
  };
}

function writeReport(path: string, report: SmokeReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const configArg = process.argv.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
  const configPath = configArg ? resolve(configArg) : join(root, "scripts/smoke.config.json");
  const config = parseSmokeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const report = await runSmoke(config, root);
  const reportPath = join(root, ".artifacts/smoke.json");
  writeReport(reportPath, report);

  if (report.start.error) console.error(`not ready: ${report.start.error}`);
  for (const check of report.checks)
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.error ? `: ${check.error}` : ""}`);
  console.log(`report: ${reportPath}`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
