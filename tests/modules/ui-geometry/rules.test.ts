import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import {
  findClippedText,
  findOffenders,
  findOutsideViewport,
  findOverlappingTargets,
  findPageOverflow,
  findSmallTargets,
  findUnequalRowHeights,
  measurePage,
  SCROLL_ATTRIBUTE,
  type Snapshot,
  TRUNCATE_ATTRIBUTE,
} from "../../../skills/repo-kit/modules/ui-geometry/templates/tests/geometry/geometry.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const PHONE = 390;

/** Lays the fixture out in headless Chromium at `width` and measures it the way check:geometry does. */
async function measure(body: string, width = PHONE, ignore: string[] = []): Promise<Snapshot> {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  try {
    await page.setContent(
      `<!doctype html><html><head><style>body{margin:0;font:16px/1.25 sans-serif}</style></head><body>${body}</body></html>`,
    );
    return await page.evaluate(measurePage, { ignore, truncateAttribute: TRUNCATE_ATTRIBUTE, scrollAttribute: SCROLL_ATTRIBUTE });
  } finally {
    await page.close();
  }
}

const elements = (offenders: { element: string }[]) => offenders.map((offender) => offender.element);

describe("page overflow", () => {
  test("flags content wider than a phone viewport", async () => {
    const offenders = findPageOverflow(await measure('<div style="width:420px;height:10px"></div>', 320));
    expect(elements(offenders)).toEqual(["page"]);
    expect(offenders[0]?.detail).toBe("the page is 420px wide in a 320px viewport");
  });

  test("passes the same wide content inside a horizontal scroller", async () => {
    const snapshot = await measure('<div style="overflow-x:auto"><div style="width:420px;height:10px"></div></div>', 320);
    expect(findPageOverflow(snapshot)).toEqual([]);
  });
});

describe("clipped text", () => {
  const box = "width:80px;overflow:hidden;white-space:nowrap";

  test("flags text cut off by a box that hides its overflow", async () => {
    const offenders = findClippedText(await measure(`<p style="${box}">Payment confirmed today</p>`));
    expect(elements(offenders)).toEqual(['p "Payment confirmed today"']);
  });

  test("passes the same box when it opts in to truncation, and text that fits", async () => {
    const snapshot = await measure(
      `<p ${TRUNCATE_ATTRIBUTE} style="${box};text-overflow:ellipsis">Payment confirmed today</p><p style="${box}">Paid</p>`,
    );
    expect(findClippedText(snapshot)).toEqual([]);
  });

  test("flags text cut off vertically", async () => {
    const snapshot = await measure('<p style="width:80px;height:20px;overflow:hidden">A sentence that wraps over three lines</p>');
    expect(findClippedText(snapshot)[0]?.detail).toMatch(/^text needs \d+px of height and gets 20px$/);
  });
});

describe("small targets", () => {
  test("flags a button under 44x44 at a phone width", async () => {
    const offenders = findSmallTargets(await measure('<button aria-label="Close" style="width:32px;height:32px">x</button>'), 480);
    expect(offenders).toEqual([{ rule: "small-target", element: 'button[aria-label="Close"]', detail: "32x32px, under 44x44px" }]);
  });

  test("passes a link inside a sentence, a 44x44 button, and the small button on a desktop", async () => {
    const phone = await measure(
      '<p>Read the <a href="/terms">terms</a> first.</p><button aria-label="Close" style="width:44px;height:44px">x</button>',
    );
    expect(findSmallTargets(phone, 480)).toEqual([]);
    const desktop = await measure('<button style="width:32px;height:32px">x</button>', 1280);
    expect(findSmallTargets(desktop, 480)).toEqual([]);
  });

  test("measures a checkbox by its label, and flags a bare one", async () => {
    const labelled = await measure(
      '<label style="display:flex;align-items:center;min-height:48px"><input type="checkbox" name="terms"> I accept the terms</label>',
    );
    expect(findSmallTargets(labelled, 480)).toEqual([]);
    const bare = await measure('<input type="checkbox" name="terms">');
    expect(elements(findSmallTargets(bare, 480))).toEqual(['input[name="terms"]']);
  });

  test("passes a native input hidden under a custom control", async () => {
    const snapshot = await measure(
      '<label style="display:block;width:48px;height:48px;position:relative"><input type="checkbox" style="position:absolute;opacity:0;width:16px;height:16px"></label>',
    );
    expect(findSmallTargets(snapshot, 480)).toEqual([]);
  });
});

describe("overlapping targets", () => {
  const button = (left: number, label: string) =>
    `<button aria-label="${label}" style="position:absolute;top:0;left:${left}px;width:60px;height:44px">${label}</button>`;

  test("flags two buttons drawn over each other", async () => {
    const offenders = findOverlappingTargets(await measure(button(0, "Save") + button(40, "Delete")));
    expect(offenders).toEqual([
      {
        rule: "overlapping-targets",
        element: 'button[aria-label="Save"] | button[aria-label="Delete"]',
        detail: "they overlap by 20x44px",
      },
    ]);
  });

  test("passes buttons that touch edge to edge", async () => {
    expect(findOverlappingTargets(await measure(button(0, "Save") + button(60, "Delete")))).toEqual([]);
  });
});

describe("unequal row heights", () => {
  const row = (input: number, action: number) =>
    `<form style="display:flex;gap:8px"><input name="email" style="height:${input}px;box-sizing:border-box"><button style="height:${action}px">Join</button></form>`;

  test("flags the shorter control in a row", async () => {
    const offenders = findUnequalRowHeights(await measure(row(36, 44)));
    expect(offenders).toEqual([
      { rule: "unequal-row-heights", element: 'form > input[name="email"]', detail: "36px tall beside a 44px control in the same row" },
    ]);
  });

  test("passes a logo link taller than the button beside it", async () => {
    const header = await measure(
      '<header style="display:flex"><a href="/" style="display:block;height:56px">Logo</a><button style="height:44px">Menu</button></header>',
    );
    expect(findUnequalRowHeights(header)).toEqual([]);
  });

  test("passes a row of equal controls, and the same controls stacked in a column", async () => {
    expect(findUnequalRowHeights(await measure(row(44, 44)))).toEqual([]);
    const column = await measure(row(36, 44).replace("display:flex", "display:flex;flex-direction:column"));
    expect(findUnequalRowHeights(column)).toEqual([]);
  });
});

describe("outside the viewport", () => {
  test("flags an element that sticks out past the right edge, even when the page hides the overflow", async () => {
    const snapshot = await measure(
      '<style>html,body{overflow-x:hidden}</style><div role="status" style="position:absolute;left:300px;width:120px;height:40px"><span>Saved</span></div>',
      320,
    );
    expect(findOutsideViewport(snapshot)).toEqual([
      { rule: "outside-viewport", element: 'div "Saved"', detail: "spans 300px to 420px, top 0px, in a 320px viewport" },
    ]);
  });

  test("flags content wider than a vertical scroll area, which scrolls sideways too", async () => {
    const snapshot = await measure(
      '<main style="height:300px;overflow-y:auto"><div style="width:600px;height:20px">Wide table</div></main>',
      320,
    );
    expect(elements(findOutsideViewport(snapshot))).toEqual(['main > div "Wide table"']);
  });

  test("passes a drawer parked fully off screen, and cards in a carousel that snaps or is marked as one", async () => {
    const cards = '<div style="flex:0 0 300px;height:40px">One</div><div style="flex:0 0 300px;height:40px">Two</div>';
    const snapshot = await measure(
      '<aside style="position:fixed;left:-300px;width:280px;height:100px">Menu</aside>' +
        `<div style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;width:320px">${cards}</div>` +
        `<div ${SCROLL_ATTRIBUTE} style="display:flex;overflow-x:auto;width:320px">${cards}</div>`,
      320,
    );
    expect(findOutsideViewport(snapshot)).toEqual([]);
  });
});

describe("offender keys", () => {
  test("describe elements by landmark, stable attributes and text with digits masked, and number repeats", async () => {
    const snapshot = await measure(
      '<nav><a href="/inbox?tab=2" style="display:inline-block;width:30px;height:30px">Inbox</a></nav>' +
        '<button style="width:30px;height:30px">Item 12</button><button style="width:30px;height:30px">Item 7</button>' +
        '<button id="radix-12" style="width:30px;height:30px">Open</button>',
    );
    expect(elements(findOffenders(snapshot, { phoneMaxWidth: 480 }).filter((offender) => offender.rule === "small-target"))).toEqual([
      'nav > a[href="/inbox"]',
      'button "Item #"',
      'button "Item #" (2)',
      'button "Open"',
    ]);
    const repeated = await measure(
      '<button style="width:30px;height:30px">Edit</button><button style="width:30px;height:30px">Edit</button>',
    );
    expect(elements(findOffenders(repeated, { phoneMaxWidth: 480 }))).toEqual(['button "Edit"', 'button "Edit" (2)']);
  });

  test("skip elements matched by an ignore selector", async () => {
    const snapshot = await measure('<div class="toaster"><button style="width:20px;height:20px">x</button></div>', PHONE, [".toaster"]);
    expect(findOffenders(snapshot, { phoneMaxWidth: 480 })).toEqual([]);
  });
});
