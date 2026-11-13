// Layout rules for check:geometry. `measurePage` runs inside the browser and returns plain data;
// every rule is a pure function of that data, so the rules run in Node and their tests need only
// a measured fixture. The baseline accepts known offenders by a key with no pixel values in it:
// route, width, rule and an element descriptor built from stable attributes and text.
//
// `measurePage` is sent to the page as source text, so it must not use anything declared outside it.

const RULE_NAMES = [
  "page-overflow",
  "clipped-text",
  "small-target",
  "overlapping-targets",
  "unequal-row-heights",
  "outside-viewport",
] as const;

export type RuleName = (typeof RULE_NAMES)[number];

type Box = { left: number; top: number; right: number; bottom: number };

type MeasuredElement = {
  descriptor: string;
  /** Position in document order, and the position of its last descendant: `a` contains `b` when a.start < b.start <= a.end. */
  start: number;
  end: number;
  parent: number;
  box: Box;
  /** The area a tap lands on: the box, or for a checkbox or radio the larger box of its label. */
  target: Box;
  interactive: boolean;
  /** A button, field or select that lines up with its siblings; checkboxes, links and inline elements are not. */
  control: boolean;
  /** An inline link or control inside a sentence, which the target-size rule exempts. */
  inlineInText: boolean;
  ownText: boolean;
  clipsX: boolean;
  clipsY: boolean;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** Carries the truncation opt-out attribute itself or through an ancestor. */
  truncates: boolean;
  /**
   * Inside an ancestor below `body` that clips horizontally, or that scrolls horizontally on purpose:
   * with scroll snapping or the scroll attribute. A computed `overflow-x: auto` alone does not count,
   * because `overflow-y: auto` turns it on too.
   */
  inScroller: boolean;
};

export type Snapshot = {
  viewport: { width: number; height: number };
  page: { scrollWidth: number; clientWidth: number };
  elements: MeasuredElement[];
};

export type Offender = { rule: RuleName; element: string; detail: string };

export type MeasureOptions = { ignore: string[]; truncateAttribute: string; scrollAttribute: string };

export const TRUNCATE_ATTRIBUTE = "data-geometry-truncate";
export const SCROLL_ATTRIBUTE = "data-geometry-scroll";

const TOLERANCE_PX = 1;
const MIN_TARGET_PX = 44;

export function measurePage(options: MeasureOptions): Snapshot {
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const CONTROL =
    'button, select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), [role="button"]';
  const LANDMARK = 'header, nav, main, footer, aside, form, dialog, [role="dialog"]';
  const ignore = options.ignore.join(", ");

  const clean = (text: string, limit: number) => {
    const words = text.replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
    return words.length > limit ? `${words.slice(0, limit)}…` : words;
  };
  const stableId = (id: string) => /^[A-Za-z_-]+$/.test(id);
  const name = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (el.id && stableId(el.id)) return `${tag}#${el.id}`;
    for (const attribute of ["data-testid", "aria-label", "name", "placeholder", "title", "alt"]) {
      const value = el.getAttribute(attribute);
      if (value) return `${tag}[${attribute}="${clean(value, 40)}"]`;
    }
    const href = el.getAttribute("href");
    if (href) return `${tag}[href="${clean(href.split(/[?#]/)[0] ?? "", 60)}"]`;
    const text = clean(el.textContent ?? "", 30);
    if (text) return `${tag} "${text}"`;
    const role = el.getAttribute("role");
    return role ? `${tag}[role="${role}"]` : tag;
  };
  const landmarkName = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && stableId(el.id)) return `${tag}#${el.id}`;
    const label = el.getAttribute("aria-label");
    return label ? `${tag}[aria-label="${clean(label, 40)}"]` : tag;
  };
  const describe = (el: Element) => {
    const landmark = el.parentElement?.closest(LANDMARK);
    return landmark ? `${landmarkName(landmark)} > ${name(el)}` : name(el);
  };
  const hasOwnText = (el: Element) =>
    [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
  const clips = (value: string) => value === "hidden" || value === "clip";
  const hidesOverflowX = (el: Element) => {
    const style = getComputedStyle(el);
    if (clips(style.overflowX)) return true;
    if (style.overflowX === "visible") return false;
    return style.scrollSnapType !== "none" || el.hasAttribute(options.scrollAttribute);
  };
  const toBox = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const area = (box: Box) => (box.right - box.left) * (box.bottom - box.top);
  const targetBox = (el: Element, own: Box) => {
    if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) return own;
    const labels = [...(el.labels ?? [])].map((label) => toBox(label.getBoundingClientRect()));
    return labels.reduce((best, label) => (area(label) > area(best) ? label : best), own);
  };

  const all = [...document.body.querySelectorAll("*")];
  const position = new Map(all.map((el, index) => [el, index]));
  const scrolling = new Map<Element, boolean>();
  const elements: MeasuredElement[] = [];

  all.forEach((el, index) => {
    const style = getComputedStyle(el);
    const parent = el.parentElement;
    const parentHides = parent !== null && parent !== document.body && hidesOverflowX(parent);
    scrolling.set(el, parentHides || (parent !== null && scrolling.get(parent) === true));

    if (ignore !== "" && el.closest(ignore)) return;
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;

    const interactive = el.matches(INTERACTIVE) && style.pointerEvents !== "none";
    const inline = style.display === "inline";
    elements.push({
      descriptor: describe(el),
      start: index,
      end: index + el.getElementsByTagName("*").length,
      parent: parent ? (position.get(parent) ?? -1) : -1,
      box: toBox(rect),
      target: targetBox(el, toBox(rect)),
      interactive,
      control: interactive && el.matches(CONTROL) && !inline,
      inlineInText: inline && parent !== null && hasOwnText(parent),
      ownText: hasOwnText(el),
      clipsX: clips(style.overflowX),
      clipsY: clips(style.overflowY),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      truncates: el.closest(`[${options.truncateAttribute}]`) !== null,
      inScroller: scrolling.get(el) === true,
    });
  });

  const scroller = document.scrollingElement ?? document.documentElement;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: { scrollWidth: scroller.scrollWidth, clientWidth: document.documentElement.clientWidth },
    elements,
  };
}

const px = (value: number) => Math.round(value);
const width = (box: Box) => box.right - box.left;
const height = (box: Box) => box.bottom - box.top;
const contains = (outer: MeasuredElement, inner: MeasuredElement) =>
  outer.start < inner.start && inner.start <= outer.end;

export function findPageOverflow(snapshot: Snapshot): Offender[] {
  const { scrollWidth, clientWidth } = snapshot.page;
  if (scrollWidth <= clientWidth + TOLERANCE_PX) return [];
  return [
    {
      rule: "page-overflow",
      element: "page",
      detail: `the page is ${scrollWidth}px wide in a ${clientWidth}px viewport`,
    },
  ];
}

export function findClippedText(snapshot: Snapshot): Offender[] {
  return snapshot.elements.flatMap((el): Offender[] => {
    if (!el.ownText || el.truncates || el.clientWidth === 0) return [];
    const wide = el.clipsX && el.scrollWidth > el.clientWidth + TOLERANCE_PX;
    const tall = el.clipsY && el.scrollHeight > el.clientHeight + TOLERANCE_PX;
    if (!wide && !tall) return [];
    const detail = wide
      ? `text needs ${el.scrollWidth}px and gets ${el.clientWidth}px`
      : `text needs ${el.scrollHeight}px of height and gets ${el.clientHeight}px`;
    return [{ rule: "clipped-text", element: el.descriptor, detail }];
  });
}

export function findSmallTargets(snapshot: Snapshot, phoneMaxWidth: number): Offender[] {
  if (snapshot.viewport.width > phoneMaxWidth) return [];
  return snapshot.elements.flatMap((el): Offender[] => {
    if (!el.interactive || el.inlineInText) return [];
    if (width(el.target) >= MIN_TARGET_PX && height(el.target) >= MIN_TARGET_PX) return [];
    const detail = `${px(width(el.target))}x${px(height(el.target))}px, under ${MIN_TARGET_PX}x${MIN_TARGET_PX}px`;
    return [{ rule: "small-target", element: el.descriptor, detail }];
  });
}

export function findOverlappingTargets(snapshot: Snapshot): Offender[] {
  const targets = snapshot.elements.filter((el) => el.interactive);
  const offenders: Offender[] = [];
  targets.forEach((a, index) => {
    for (const b of targets.slice(index + 1)) {
      if (contains(a, b) || contains(b, a)) continue;
      const overlapX = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const overlapY = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (overlapX <= TOLERANCE_PX || overlapY <= TOLERANCE_PX) continue;
      offenders.push({
        rule: "overlapping-targets",
        element: `${a.descriptor} | ${b.descriptor}`,
        detail: `they overlap by ${px(overlapX)}x${px(overlapY)}px`,
      });
    }
  });
  return offenders;
}

export function findUnequalRowHeights(snapshot: Snapshot): Offender[] {
  const controls = snapshot.elements.filter((el) => el.control);
  return controls.flatMap((el): Offender[] => {
    const tallest = controls
      .filter((other) => other !== el && other.parent === el.parent)
      .filter((other) => other.box.top < el.box.bottom && el.box.top < other.box.bottom)
      .reduce((max, other) => Math.max(max, height(other.box)), 0);
    if (tallest - height(el.box) <= TOLERANCE_PX) return [];
    const detail = `${px(height(el.box))}px tall beside a ${px(tallest)}px control in the same row`;
    return [{ rule: "unequal-row-heights", element: el.descriptor, detail }];
  });
}

export function findOutsideViewport(snapshot: Snapshot): Offender[] {
  const { width: viewportWidth } = snapshot.viewport;
  const sticking = snapshot.elements.filter((el) => {
    if (el.inScroller) return false;
    const { left, right, top, bottom } = el.box;
    const partlyInside = right > 0 && left < viewportWidth && bottom > 0;
    const out = left < -TOLERANCE_PX || right > viewportWidth + TOLERANCE_PX || top < -TOLERANCE_PX;
    return partlyInside && out;
  });
  return sticking
    .filter((el) => !sticking.some((outer) => contains(outer, el)))
    .map((el) => ({
      rule: "outside-viewport",
      element: el.descriptor,
      detail: `spans ${px(el.box.left)}px to ${px(el.box.right)}px, top ${px(el.box.top)}px, in a ${viewportWidth}px viewport`,
    }));
}

/** Every rule's offenders, with ` (2)`, ` (3)` added to repeats of one rule and descriptor so each key stays unique. */
export function findOffenders(snapshot: Snapshot, options: { phoneMaxWidth: number }): Offender[] {
  const offenders = [
    ...findPageOverflow(snapshot),
    ...findClippedText(snapshot),
    ...findSmallTargets(snapshot, options.phoneMaxWidth),
    ...findOverlappingTargets(snapshot),
    ...findUnequalRowHeights(snapshot),
    ...findOutsideViewport(snapshot),
  ];
  const seen = new Map<string, number>();
  return offenders.map((offender) => {
    const key = `${offender.rule} ${offender.element}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? offender : { ...offender, element: `${offender.element} (${count})` };
  });
}

export type GeometryRoute = { path: string; waitFor: string | null };

export type GeometryConfig = {
  command: string;
  routes: GeometryRoute[];
  widths: number[];
  phoneMaxWidth: number;
  viewportHeight: number;
  ignore: string[];
  knownPageErrors: string[];
};

export type BaselineEntry = { route: string; width: number; rule: RuleName; element: string };
export type PageResult = { route: string; width: number; offenders: Offender[] };

const RULES = new Set<string>(RULE_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`geometry: ${message}`);
}

const isRuleName = (value: unknown): value is RuleName => typeof value === "string" && RULES.has(value);
const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

export function parseGeometryConfig(raw: unknown): GeometryConfig {
  if (!isRecord(raw)) fail("geometry.config.json must be a JSON object");
  const { command, routes, widths, phoneMaxWidth = 480, viewportHeight = 800, ignore = [], knownPageErrors = [] } = raw;
  if (typeof command !== "string" || command === "") fail("command must be the Playwright command line");
  if (!Array.isArray(routes) || routes.length === 0) fail("routes must list at least one route");
  if (!Array.isArray(widths) || widths.length === 0 || !widths.every(isPositive))
    fail("widths must list whole pixel widths");
  if (!isPositive(phoneMaxWidth) || !isPositive(viewportHeight))
    fail("phoneMaxWidth and viewportHeight must be whole pixels");
  if (!Array.isArray(ignore) || !ignore.every((selector) => typeof selector === "string"))
    fail("ignore must list CSS selectors");
  if (!Array.isArray(knownPageErrors) || !knownPageErrors.every((text) => typeof text === "string" && text !== ""))
    fail("knownPageErrors must list parts of error messages");
  return {
    command,
    routes: routes.map((route, index): GeometryRoute => {
      if (typeof route === "string" && route.startsWith("/")) return { path: route, waitFor: null };
      if (isRecord(route) && typeof route.path === "string" && route.path.startsWith("/")) {
        if (route.waitFor !== undefined && typeof route.waitFor !== "string")
          fail(`routes[${index}].waitFor must be a selector`);
        return { path: route.path, waitFor: route.waitFor ?? null };
      }
      return fail(`routes[${index}] must be a path starting with / or { "path", "waitFor" }`);
    }),
    widths,
    phoneMaxWidth,
    viewportHeight,
    ignore,
    knownPageErrors,
  };
}

export function parseBaseline(raw: unknown): BaselineEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.offenders)) fail('baseline.json must be { "offenders": [...] }');
  return raw.offenders.map((entry, index): BaselineEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.route !== "string" ||
      !isPositive(entry.width) ||
      !isRuleName(entry.rule) ||
      typeof entry.element !== "string"
    ) {
      return fail(`baseline offenders[${index}] needs route, width, rule and element`);
    }
    return { route: entry.route, width: entry.width, rule: entry.rule, element: entry.element };
  });
}

export function parsePageResult(raw: unknown): PageResult {
  if (!isRecord(raw) || typeof raw.route !== "string" || !isPositive(raw.width) || !Array.isArray(raw.offenders)) {
    return fail("a result file needs route, width and offenders");
  }
  const offenders = raw.offenders.map((offender): Offender => {
    if (
      !isRecord(offender) ||
      !isRuleName(offender.rule) ||
      typeof offender.element !== "string" ||
      typeof offender.detail !== "string"
    ) {
      return fail(`a result for ${raw.route} has a malformed offender`);
    }
    return { rule: offender.rule, element: offender.element, detail: offender.detail };
  });
  return { route: raw.route, width: raw.width, offenders };
}

const pageKey = (page: { route: string; width: number }) => `${page.route} @${page.width}`;
const entryKey = (entry: { route: string; width: number; rule: string; element: string }) =>
  `${pageKey(entry)} ${entry.rule} ${entry.element}`;

export function describeOffender(result: { route: string; width: number }, offender: Offender): string {
  return `${entryKey({ ...result, ...offender })}: ${offender.detail}`;
}

/** New offenders, and baseline entries for the measured pages that no longer occur. Pages not measured are left alone. */
export function compareWithBaseline(
  baseline: BaselineEntry[],
  results: PageResult[],
): { added: string[]; fixed: BaselineEntry[] } {
  const known = new Set(baseline.map(entryKey));
  const found = new Set(
    results.flatMap((result) => result.offenders.map((offender) => entryKey({ ...result, ...offender }))),
  );
  const measured = new Set(results.map(pageKey));
  return {
    added: results.flatMap((result) =>
      result.offenders
        .filter((offender) => !known.has(entryKey({ ...result, ...offender })))
        .map((offender) => describeOffender(result, offender)),
    ),
    fixed: baseline.filter((entry) => measured.has(pageKey(entry)) && !found.has(entryKey(entry))),
  };
}

/** The baseline with every measured page's entries replaced by what was found there, sorted so diffs stay small. */
export function updateBaseline(baseline: BaselineEntry[], results: PageResult[]): BaselineEntry[] {
  const measured = new Set(results.map(pageKey));
  const kept = baseline.filter((entry) => !measured.has(pageKey(entry)));
  const found = results.flatMap((result) =>
    result.offenders.map((offender) => ({
      route: result.route,
      width: result.width,
      rule: offender.rule,
      element: offender.element,
    })),
  );
  return [...kept, ...found].sort(
    (a, b) =>
      a.route.localeCompare(b.route) ||
      a.width - b.width ||
      a.rule.localeCompare(b.rule) ||
      a.element.localeCompare(b.element),
  );
}
