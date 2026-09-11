// Saved meals: create once, log with one tap, and come back after a reload.
// Runs against the db fake, so this also covers the storage round trip.

import {
  launch, openPage, installDb, methodByName, check, checkText, checkTruthy, noPageErrors, finish,
} from "./harness.mjs";

const browser = await launch();
const page = await openPage(browser, { initScript: installDb });

/* ---------------- create ---------------- */
await page.click('nav.seg button:text-is("Meals")');
await page.waitForTimeout(250);
await page.click("button.btn-primary");                // New saved meal
await page.waitForTimeout(200);
await page.fill("#ml-name", "tiramisu_oats");
await page.fill("#ml-grams", "380");
await page.fill("#ml-calories", "612");
await page.fill("#ml-protein", "48");
await page.fill("#ml-carbs", "74");
await page.fill("#ml-fat", "14");
await page.fill("#ml-fiber", "11");
await page.click(".meal-form button.btn-primary");
await page.waitForTimeout(350);

checkText("saves the meal", await page.textContent(".meal-name"), "tiramisu_oats");

/* ---------------- one-tap logging ---------------- */
await page.click('nav.seg button:text-is("Today")');
await page.waitForTimeout(300);
checkText("shows it on the Today strip", await page.textContent(".meal-chip-name"), "tiramisu_oats");

await page.click(".meal-chip");
await page.waitForTimeout(350);
checkText("one tap logs it", await page.textContent(".cal-value"), "612");

await page.click(".meal-chip");
await page.waitForTimeout(350);
checkText("a second tap logs it again", await page.textContent(".cal-value"), "1 224");
check("as two separate entries", (await page.$$(".entry")).length, 2);

// An entry that came from a saved meal shouldn't offer to save it again.
check("no re-save button on meal entries", (await page.$$(".entry .bookmark-btn")).length, 0);

/* ---------------- survives a reload ---------------- */
await page.reload();
await page.waitForTimeout(700);
checkText("totals come back from storage", await page.textContent(".cal-value"), "1 224");
checkText("saved meal comes back too", await page.textContent(".meal-chip-name"), "tiramisu_oats");

/* ---------------- save a logged entry as a meal ---------------- */
await page.click(methodByName("By hand"));
await page.waitForTimeout(200);
await page.fill("#mn-name", "post_bjj_shake");
await page.fill("#mn-calories", "250");
await page.fill("#mn-protein", "25");
await page.click(".flow button.btn-primary");
await page.waitForTimeout(300);
await page.click(".entry .bookmark-btn");
await page.waitForTimeout(400);

checkTruthy("confirms the save", (await page.textContent(".toast")).includes("post_bjj_shake"));
checkText("both meals now on the strip",
  await page.$$eval(".meal-chip-name", (e) => e.map((x) => x.textContent)),
  ["tiramisu_oats", "post_bjj_shake"]);            // most-logged first

/* ---------------- usage count, then delete ---------------- */
await page.click('nav.seg button:text-is("Meals")');
await page.waitForTimeout(300);
checkTruthy("counts how often it was logged",
  (await page.textContent(".meal-macros")).includes("logged 2×"));

await page.click('.meal-row:nth-child(2) .meal-actions button:text-is("Delete")');
await page.waitForTimeout(200);
await page.click(".meal-row:nth-child(2) .btn-danger");   // confirm
await page.waitForTimeout(350);
checkText("deletes only the one asked for",
  await page.$$eval(".meal-name", (e) => e.map((x) => x.textContent)),
  ["tiramisu_oats"]);

noPageErrors(page);
await browser.close();
finish("meals");
