// The Playwright side of check:geometry: opens each route at each width, measures the page and
// fails on offenders that baseline.json does not list. Run it through `check:geometry`, which sets
// GEOMETRY_CONFIG; a plain `playwright test` run skips it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  compareWithBaseline,
  findOffenders,
  measurePage,
  type PageResult,
  parseBaseline,
  parseGeometryConfig,
  SCROLL_ATTRIBUTE,
  TRUNCATE_ATTRIBUTE,
} from "./geometry";

const configPath = process.env.GEOMETRY_CONFIG;

if (configPath === undefined) {
  test("layout geometry", () => {
    test.skip(true, "run it with check:geometry, which sets GEOMETRY_CONFIG");
  });
} else {
  const config = parseGeometryConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const baseline = parseBaseline(JSON.parse(readFileSync(join(dirname(configPath), "baseline.json"), "utf8")));
  const resultsDir = process.env.GEOMETRY_RESULTS_DIR;
  const updating = process.env.GEOMETRY_UPDATE === "1";

  for (const width of config.widths) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: config.viewportHeight } });

      for (const route of config.routes) {
        test(route.path, async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => {
            if (!config.knownPageErrors.some((known) => error.message.includes(known))) pageErrors.push(error.message);
          });
          await page.emulateMedia({ reducedMotion: "reduce" });
          const response = await page.goto(route.path, { waitUntil: "load" });
          expect(response?.status() ?? 200, `${route.path} answered with an error`).toBeLessThan(400);
          if (route.waitFor !== null) await page.locator(route.waitFor).first().waitFor();
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          // A redirect (to a login page, say) or a crashed render would be measured as this route and pass.
          const landed = new URL(page.url()).pathname;
          const asked = new URL(route.path, page.url()).pathname;
          expect(landed, `${route.path} ended on ${landed}`).toBe(asked);
          expect(pageErrors, `${route.path} threw while rendering`).toEqual([]);

          const snapshot = await page.evaluate(measurePage, {
            ignore: config.ignore,
            truncateAttribute: TRUNCATE_ATTRIBUTE,
            scrollAttribute: SCROLL_ATTRIBUTE,
          });
          const result: PageResult = { route: route.path, width, offenders: findOffenders(snapshot, config) };
          if (resultsDir !== undefined) {
            mkdirSync(resultsDir, { recursive: true });
            writeFileSync(
              join(resultsDir, `${encodeURIComponent(route.path)}@${width}.json`),
              `${JSON.stringify(result, null, 2)}\n`,
            );
          }
          if (updating) return;
          const { added } = compareWithBaseline(baseline, [result]);
          expect(added, "new layout offenders: fix them, or accept them with check:geometry --update").toEqual([]);
        });
      }
    });
  }
}
