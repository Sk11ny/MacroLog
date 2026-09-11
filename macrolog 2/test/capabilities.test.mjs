// Which logging methods the page offers, for every shape the runtime can take.
//
// This is the test that matters most in practice: the page runs inside viewers
// with different abilities, and it must never offer something that cannot work,
// nor hide something that can.

import { launch, openPage, installRuntime, check, finish } from "./harness.mjs";

const CASES = [
  // mode,               methods offered
  // Barcode scanning is pure client-side work, so it survives every runtime:
  // even with no Claude at all it still matches products you have saved.
  ["desktop",            ["Scan barcode", "Label photo", "Food photo", "Describe it", "By hand"]],
  ["no-limits-fn",       ["Scan barcode", "Label photo", "Food photo", "Describe it", "By hand"]],
  ["limits-throws",      ["Scan barcode", "Label photo", "Food photo", "Describe it", "By hand"]],
  ["mobile",             ["Scan barcode", "Describe it", "By hand"]],
  ["limits-no-images",   ["Scan barcode", "Describe it", "By hand"]],
  ["no-sample",          ["Scan barcode", "By hand"]],
  ["no-runtime",         ["Scan barcode", "By hand"]],
];

const browser = await launch();

for (const [mode, expected] of CASES) {
  const page = await openPage(browser, { initScript: installRuntime, arg: mode });
  const offered = await page.$$eval(".method-text strong", (els) => els.map((e) => e.textContent));
  check(`${mode.padEnd(17)} offers the right methods`, offered, expected);
  check(`${mode.padEnd(17)} raises no page errors`, page.pageErrors, []);
  await page.close();
}

// A probe that cannot answer must NOT switch photos off: only a plain "no" does.
// (Getting this backwards is what once left the photo buttons dead on desktop,
// and getting it the other way let a phone take photos that had nowhere to go.)

await browser.close();
finish("capabilities");
