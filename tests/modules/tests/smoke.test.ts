import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseSmokeConfig, runSmoke, type SmokeConfig } from "../../../skill/modules/tests/templates/scripts/smoke.ts";
import { applyModules, removeTempDirs, tempDir, writeFiles } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

/** A start command for a server that answers /health once it is up and serves a page at /. */
function serverCommand(port: number): string {
  const app = `require("node:http").createServer((req, res) => {
    if (req.url === "/health") return res.end("ok");
    if (req.url === "/") return res.end("<html>shop</html>");
    res.statusCode = 404; res.end();
  }).listen(${port}, "127.0.0.1")`;
  return `node -e '${app}'`;
}

function config(port: number, overrides: Partial<SmokeConfig> = {}): SmokeConfig {
  const base = `http://127.0.0.1:${port}`;
  return {
    start: serverCommand(port),
    env: {},
    healthUrl: `${base}/health`,
    startTimeoutMs: 10_000,
    checks: [
      { name: "home", url: `${base}/`, method: "GET", status: 200, bodyIncludes: "shop" },
      { name: "missing page", url: `${base}/nope`, method: "GET", status: 404, bodyIncludes: null },
    ],
    ...overrides,
  };
}

describe("runSmoke", () => {
  test("starts the app, waits for health, runs every check, and stops the app", async () => {
    const port = await freePort();
    const report = await runSmoke(config(port), tempDir());
    expect(report.ok).toBe(true);
    expect(report.start.ready).toBe(true);
    expect(report.checks.map((check) => [check.name, check.ok, check.status])).toEqual([
      ["home", true, 200],
      ["missing page", true, 404],
    ]);
    const afterStop = await fetch(`http://127.0.0.1:${port}/health`).then(
      () => "still running",
      () => "stopped",
    );
    expect(afterStop).toBe("stopped");
  });

  test("reports a check whose status or body is wrong", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const report = await runSmoke(
      config(port, {
        checks: [
          { name: "wrong body", url: `${base}/`, method: "GET", status: 200, bodyIncludes: "cart" },
          { name: "wrong status", url: `${base}/nope`, method: "GET", status: 200, bodyIncludes: null },
        ],
      }),
      tempDir(),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.error)).toEqual(['body does not include "cart"', "expected status 200, got 404"]);
  });

  test("fails fast with the exit reason when the app dies before it is healthy", async () => {
    const port = await freePort();
    const started = Date.now();
    const report = await runSmoke(config(port, { start: "echo boom >&2; exit 3", startTimeoutMs: 30_000 }), tempDir());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.ok).toBe(false);
    expect(report.start.error).toContain("exit code 3");
    expect(report.appOutputTail).toEqual(["boom"]);
    expect(report.checks).toEqual([]);
  });
});

describe("parseSmokeConfig", () => {
  test("fills defaults for a check's method and status", () => {
    const parsed = parseSmokeConfig({ start: "x", healthUrl: "http://h/health", checks: [{ name: "a", url: "http://h/" }] });
    expect(parsed.checks).toEqual([{ name: "a", url: "http://h/", method: "GET", status: 200, bodyIncludes: null }]);
    expect(parsed.startTimeoutMs).toBe(60_000);
  });

  test("rejects a config without checks", () => {
    expect(() => parseSmokeConfig({ start: "x", healthUrl: "http://h/health", checks: [] })).toThrow("checks must list at least one check");
  });
});

test("the smoke script writes .artifacts/smoke.json and exits 1 when a check fails", async () => {
  const project = applyModules({ lockfile: "pnpm-lock.yaml", modules: ["tests"] });
  const port = await freePort();
  const failing = config(port, {
    checks: [{ name: "home", url: `http://127.0.0.1:${port}/`, method: "GET", status: 201, bodyIncludes: null }],
  });
  writeFiles(project, { "scripts/smoke.config.json": JSON.stringify(failing) });

  const result = spawnSync("node", ["scripts/smoke.ts"], { cwd: project, encoding: "utf8" });
  expect(result.status).toBe(1);
  const report = JSON.parse(readFileSync(join(project, ".artifacts/smoke.json"), "utf8"));
  expect(report.ok).toBe(false);
  expect(report.checks[0].error).toBe("expected status 201, got 200");
});
