// Shared bits for the test suite.
//
// Every test drives the REAL built page (dist/macrolog.local.html) in Chromium
// and fakes only what sits outside the page: the artifact runtime's `window.claude`.
// Nothing in src/ is stubbed or re-implemented, so a passing test means the
// shipped file works.

import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE = join(ROOT, "dist", "macrolog.local.html");

if (!existsSync(PAGE)) {
  console.error("dist/macrolog.local.html is missing — run `npm run build:local` first.");
  process.exit(1);
}

export const PAGE_URL = pathToFileURL(PAGE).href;

// Chromium's fake webcam, so the live viewfinder can be driven headlessly.
export async function launch({ fakeCamera = false } = {}) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: fakeCamera
      ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
      : [],
  });
}

// One context per "device": pages in the same context share origin storage,
// pages in different contexts do not.
export async function newDevice(browser, { width = 430, height = 1100 } = {}) {
  return browser.newContext({ viewport: { width, height } });
}

export async function openPage(browser, { initScript, arg, scripts, context, width = 430, height = 1100 } = {}) {
  const page = context
    ? await context.newPage()
    : await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (initScript) await page.addInitScript(initScript, arg);
  for (const [fn, a] of scripts || []) await page.addInitScript(fn, a);
  await page.goto(PAGE_URL);
  await page.waitForTimeout(450);
  page.pageErrors = errors;
  return page;
}

// Click one of the "add" methods by its visible label rather than its position:
// which methods exist depends on what the runtime can do.
export const methodByName = (name) =>
  `.methods .method:has(strong:text-is("${name}"))`;

/* ------------------------------------------------------------------ *
 * window.claude fakes
 * ------------------------------------------------------------------ */

/**
 * A `sample` capability whose shape mirrors a real viewer.
 *   mode "desktop" — text and images both work
 *   mode "mobile"  — text works, images rejected (what the Claude iOS app does)
 *   mode "no-sample" / "no-runtime" — capability or runtime absent
 * These run as init scripts, so they must be fully self-contained.
 */
export function installRuntime(mode) {
  const canned = {
    label: {
      productName: "Skyr Natural", basis: "100g", servingGrams: 150,
      per: { calories: 63, protein: 11, carbs: 4, fat: 0.2, fiber: null },
      unreadable: [], notes: null,
    },
    estimate: {
      name: "Chicken, rice and spinach",
      items: [{ name: "chicken thigh", approxGrams: 200 }, { name: "cooked rice", approxGrams: 150 }],
      total: { calories: 735, protein: 62, carbs: 78, fat: 14, fiber: 7 },
      assumptions: "Assumed plain rice and a tablespoon of oil in the pan.",
      confidence: "medium",
    },
  };

  window.__calls = [];

  if (mode === "no-runtime") {
    try { delete window.claude; } catch (e) { window.claude = undefined; }
    return;
  }

  const makeSample = () => {
    const s = async () => ({ text: "", truncated: false, modelTierApplied: "default" });
    s.json = async (input, opts) => {
      const hasImages = !!(opts && opts.images);
      window.__calls.push({ hasImages, head: String(input).slice(0, 44) });
      await new Promise((r) => setTimeout(r, 60));
      if (hasImages && mode === "mobile") {
        throw { code: "images_unavailable", message: "this view cannot send images" };
      }
      if (window.__forceError) throw window.__forceError;
      // Which canned answer to give is decided by the prompt the page sent.
      return String(input).startsWith("You are reading a photograph") ? canned.label : canned.estimate;
    };
    if (mode !== "no-limits-fn") {
      s.limits = async () => {
        if (mode === "limits-throws") throw { code: "capability_removed", message: "gone" };
        if (mode === "mobile" || mode === "limits-no-images") return { maxPromptBytes: 65536 };
        return {
          maxPromptBytes: 65536,
          images: { maxCount: 4, maxInputBytes: 2e7, mediaTypes: ["image/jpeg", "image/png"] },
        };
      };
    }
    return s;
  };

  window.claude = {
    use: async (name) => {
      if (name === "sample") return mode === "no-sample" ? null : makeSample();
      return null;                       // db off: the page falls back to localStorage
    },
  };
}

/**
 * A `db` fake that honours the real contract — `data()` is a METHOD, not a
 * property — and persists in sessionStorage so reloads can be tested.
 */
export function installDb() {
  const KEY = "__fakedb";
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  const write = (o) => sessionStorage.setItem(KEY, JSON.stringify(o));
  const snapFor = (p) => {
    const st = read();
    return {
      id: p.split("/").pop(),
      exists: Object.prototype.hasOwnProperty.call(st, p),
      data: () => st[p],
      metadata: { fromCache: false, hasPendingWrites: false },
    };
  };
  const mkQuery = (col, opts) => ({
    orderBy: (f, d) => mkQuery(col, { ...opts, orderBy: [f, d] }),
    limit: (n) => mkQuery(col, { ...opts, limit: n }),
    where: () => mkQuery(col, opts),
    get: async () => {
      const st = read();
      const depth = col.split("/").length + 1;
      let docs = Object.keys(st)
        .filter((k) => k.startsWith(col + "/") && k.split("/").length === depth)
        .map(snapFor);
      if (opts.orderBy) {
        const [f, dir] = opts.orderBy;
        docs.sort((a, b) => {
          const av = a.data()[f], bv = b.data()[f];
          return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === "desc" ? -1 : 1);
        });
      } else docs.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (opts.limit) docs = docs.slice(0, opts.limit);
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    },
    onSnapshot: () => () => {},
  });
  const mkDoc = (p) => ({
    path: p, id: p.split("/").pop(),
    get: async () => snapFor(p),
    set: async (d) => { const st = read(); st[p] = JSON.parse(JSON.stringify(d)); write(st); },
    update: async (d) => { const st = read(); st[p] = { ...(st[p] || {}), ...d }; write(st); },
    delete: async () => { const st = read(); delete st[p]; write(st); },
    onSnapshot: (next) => { next(snapFor(p)); return () => {}; },
    collection: (c) => mkQuery(p + "/" + c, {}),
  });

  window.claude = {
    use: async (n) =>
      n === "db"
        ? { doc: mkDoc, collection: (p) => Object.assign(mkQuery(p, {}), { path: p, doc: (id) => mkDoc(p + "/" + id) }) }
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * tiny assertion helpers
 * ------------------------------------------------------------------ */

let failures = 0;

export function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${e}\n        actual   ${a}`}`);
}

// Rendered numbers group digits with a narrow no-break space (U+202F), which is
// correct typography but invisible in a diff. Compare UI text with this so an
// assertion never hinges on which Unicode space a formatter chose.
const flattenSpace = (v) =>
  Array.isArray(v) ? v.map(flattenSpace)
  : typeof v === "string" ? v.replace(/[\s\u00a0\u202f\u2009]+/g, " ").trim()
  : v;

export function checkText(label, actual, expected) {
  check(label, flattenSpace(actual), flattenSpace(expected));
}

export function checkTruthy(label, actual) {
  const ok = !!actual;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)})`}`);
}

export function noPageErrors(page) {
  check("no uncaught page errors", page.pageErrors, []);
}

export function finish(name) {
  console.log(failures === 0 ? `\n${name}: all checks passed\n` : `\n${name}: ${failures} FAILED\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}
