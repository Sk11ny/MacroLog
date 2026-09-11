// The three ways food gets into the log: a nutrition label, a description, and
// by hand — plus what happens when a request fails.

import {
  launch, openPage, installRuntime, methodByName, check, checkText, checkTruthy, noPageErrors, finish,
} from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TINY_PNG = join(HERE, ".tiny.png");
writeFileSync(TINY_PNG, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFJIjSokKSRBFQIAtxwCAeQGKS8AAAAASUVORK5CYII=",
  "base64"));

const browser = await launch();

/* ---------------- label photo: parse, correct, scale ---------------- */
{
  console.log("label photo");
  const page = await openPage(browser, { initScript: installRuntime, arg: "desktop" });
  await page.click(methodByName("Label photo"));
  await page.waitForTimeout(200);
  await page.setInputFiles("input[type=file]", TINY_PNG);
  await page.waitForSelector("#lb-amt", { timeout: 5000 });

  check("reads the printed per-100g values", {
    name: await page.inputValue("#lb-name"),
    kcal: await page.inputValue("#lb-calories"),
    protein: await page.inputValue("#lb-protein"),
  }, { name: "Skyr Natural", kcal: "63", protein: "11" });

  // Sub-gram values must survive: rounding per-100g first would lose them.
  check("keeps sub-gram fat from the label", await page.inputValue("#lb-fat"), "0.2");
  check("leaves unprinted fibre blank", await page.inputValue("#lb-fiber"), "");

  await page.fill("#lb-amt", "250");
  await page.waitForTimeout(200);
  await page.click(".flow button.btn-primary");
  await page.waitForTimeout(300);

  checkText("scales 63 kcal/100g over 250 g", await page.textContent(".cal-value"), "158");
  checkText("scales protein too", await page.textContent(".macro-value"), "28");
  checkText("names the entry from the label", await page.textContent(".entry-name"), "Skyr Natural");
  noPageErrors(page);
  await page.close();
}

/* ---------------- describe it: the path that works on mobile ---------------- */
{
  console.log("\ndescribe a meal");
  const page = await openPage(browser, { initScript: installRuntime, arg: "mobile" });
  await page.click(methodByName("Describe it"));
  await page.waitForTimeout(200);
  await page.fill("#ds-text", "200g chicken thigh, 150g cooked rice, spinach, tbsp olive oil");
  await page.click(".flow button.btn-primary");
  await page.waitForTimeout(600);

  const calls = await page.evaluate(() => window.__calls);
  check("sends no image (text-only request)", calls.map((c) => c.hasImages), [false]);
  check("prefills the estimate", await page.inputValue("#ph-calories"), "735");

  // The portion scaler rewrites every value from the original estimate.
  await page.click('.scale-controls button[aria-label="Smaller portion"]');
  await page.waitForTimeout(200);
  check("0.75x portion scales calories", await page.inputValue("#ph-calories"), "551");
  check("0.75x portion scales protein", await page.inputValue("#ph-protein"), "47");

  await page.click(".flow button.btn-primary");
  await page.waitForTimeout(300);
  checkTruthy("marks it as an estimate", await page.$(".entry .chip-est"));
  noPageErrors(page);
  await page.close();
}

/* ---------------- by hand ---------------- */
{
  console.log("\nby hand");
  const page = await openPage(browser, { initScript: installRuntime, arg: "no-runtime" });
  await page.click(methodByName("By hand"));
  await page.waitForTimeout(200);
  await page.fill("#mn-name", "post_bjj_shake");
  await page.fill("#mn-calories", "250");
  await page.fill("#mn-protein", "25");
  await page.click(".flow button.btn-primary");
  await page.waitForTimeout(300);
  checkText("logs a typed entry", await page.textContent(".entry-name"), "post_bjj_shake");
  checkText("counts it toward the day", await page.textContent(".cal-value"), "250");
  noPageErrors(page);
  await page.close();
}

/* ---------------- failures explain themselves ---------------- */
{
  console.log("\nerror handling");
  const page = await openPage(browser, { initScript: installRuntime, arg: "desktop" });
  await page.evaluate(() => { window.__forceError = { code: "invalid_json", message: "no JSON in reply" }; });
  await page.click(methodByName("Label photo"));
  await page.waitForTimeout(200);
  await page.setInputFiles("input[type=file]", TINY_PNG);
  await page.waitForSelector(".error-panel", { timeout: 5000 });

  checkText("shows the rejection code", (await page.textContent(".error-code")).trim(), "reported as: invalid_json");
  const buttons = await page.$$eval(".error-panel button", (e) => e.map((x) => x.textContent.trim()));
  check("offers retry and a manual fallback", buttons, ["Try again", "Enter by hand"]);

  // A dead capability must not offer a retry that can only fail again.
  await page.evaluate(() => { window.__forceError = { code: "not_granted", message: "nope" }; });
  await page.click(".error-panel button");           // Try again
  await page.waitForTimeout(500);
  const after = await page.$$eval(".error-panel button", (e) => e.map((x) => x.textContent.trim()));
  check("drops retry once the capability is gone", after, ["Enter by hand"]);
  noPageErrors(page);
  await page.close();
}

await browser.close();
finish("logging");
