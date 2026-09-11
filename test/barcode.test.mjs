// Barcode scanning and the Open Food Facts lookup.
//
// NOTE: openfoodfacts.org was unreachable from the machine this was written on,
// so the payloads below are built from their documented API v2 shape rather
// than from a captured response. If a real scan comes back with fields in the
// wrong boxes, fix `parseOffProduct` and add the real shape here.

import {
  launch, openPage, installDb, methodByName, check, checkText, checkTruthy, noPageErrors, finish,
} from "./harness.mjs";

// Deterministic: no camera, so the flow goes straight to its typed-entry path.
const noCamera = () => {
  try {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  } catch (e) { /* fine */ }
};

// Serve a canned Open Food Facts reply, or fail the way a blocked CSP does.
const mockOff = (spec) => {
  window.__offCalls = [];
  window.fetch = async (url) => {
    window.__offCalls.push(String(url));
    if (spec.mode === "blocked") throw new TypeError("Failed to fetch");
    if (spec.mode === "http") return new Response("nope", { status: 502 });
    return new Response(JSON.stringify(spec.body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
};

const CEREAL = {
  code: "5010029000016", status: 1, status_verbose: "product found",
  product: {
    product_name: "Porridge Oats", brands: "Quaker", quantity: "1 kg",
    serving_size: "30 g", nutrition_data_per: "100g",
    nutriments: {
      "energy-kcal_100g": 379, "energy-kj_100g": 1585,
      proteins_100g: 11, carbohydrates_100g: 60, fat_100g: 8, fiber_100g: 9,
    },
  },
};

const scanTo = async (page, code) => {
  await page.click(methodByName("Scan barcode"));
  await page.waitForSelector("#sc-manual", { timeout: 5000 });
  await page.fill("#sc-manual", code);
  await page.click('.flow .mini-panel button:text-is("Look it up")');
};

const browser = await launch();

/* ---------- a barcode you have already saved needs no network ---------- */
{
  console.log("saved barcode");
  const page = await openPage(browser, {
    scripts: [[installDb], [noCamera], [mockOff, { mode: "blocked" }]],
  });

  await page.click('nav.seg button:text-is("Meals")');
  await page.waitForTimeout(250);
  await page.click("button.btn-primary");
  await page.waitForTimeout(200);
  await page.fill("#ml-name", "tiramisu_oats");
  await page.fill("#ml-grams", "380");
  await page.fill("#ml-barcode", "5010029000016");
  await page.fill("#ml-calories", "612");
  await page.fill("#ml-protein", "48");
  await page.click(".meal-form button.btn-primary");
  await page.waitForTimeout(350);

  await page.click('nav.seg button:text-is("Today")');
  await page.waitForTimeout(250);
  await scanTo(page, "5010029000016");
  await page.waitForSelector(".known-meal", { timeout: 5000 });

  checkText("recognises a saved barcode", await page.textContent(".known-name"), "tiramisu_oats");
  check("and never calls out to the network", await page.evaluate(() => window.__offCalls), []);

  await page.click('.flow button:text-is("Log it")');
  await page.waitForTimeout(400);
  checkText("logs it in one tap", await page.textContent(".cal-value"), "612");
  noPageErrors(page);
  await page.close();
}

/* ---------- an unknown barcode gets looked up ---------- */
{
  console.log("\nOpen Food Facts lookup");
  const page = await openPage(browser, {
    scripts: [[installDb], [noCamera], [mockOff, { mode: "ok", body: CEREAL }]],
  });
  await scanTo(page, "5010029000016");
  await page.waitForSelector("#sc-amt", { timeout: 5000 });

  const url = (await page.evaluate(() => window.__offCalls))[0];
  checkTruthy("asks OFF for that barcode", url.includes("/api/v2/product/5010029000016.json"));
  checkTruthy("and asks only for the fields it needs", url.includes("fields="));

  check("maps the per-100g values", {
    name: await page.inputValue("#sc-name"),
    kcal: await page.inputValue("#sc-calories"),
    protein: await page.inputValue("#sc-protein"),
    carbs: await page.inputValue("#sc-carbs"),
    fat: await page.inputValue("#sc-fat"),
    fiber: await page.inputValue("#sc-fiber"),
  }, { name: "Porridge Oats", kcal: "379", protein: "11", carbs: "60", fat: "8", fiber: "9" });

  check("prefills the printed serving size", await page.inputValue("#sc-amt"), "30");

  await page.fill("#sc-amt", "80");
  await page.waitForTimeout(250);
  await page.click('.flow button:text-is("Save entry")');
  await page.waitForTimeout(450);

  checkText("scales 379 kcal/100g over 80 g", await page.textContent(".cal-value"), "303");
  checkText("names the entry from the product", await page.textContent(".entry-name"), "Porridge Oats");

  // "Save as a meal" is on by default, so the barcode is known from now on.
  checkText("keeps it as a saved meal", await page.textContent(".meal-chip-name"), "Porridge Oats");
  await page.click('nav.seg button:text-is("Meals")');
  await page.waitForTimeout(300);
  checkTruthy("with the barcode attached",
    (await page.textContent(".meal-macros")).includes("5010029000016"));
  noPageErrors(page);
  await page.close();
}

/* ---------- energy in kJ only ---------- */
{
  console.log("\nkJ-only energy");
  const kjOnly = JSON.parse(JSON.stringify(CEREAL));
  delete kjOnly.product.nutriments["energy-kcal_100g"];
  delete kjOnly.product.nutriments.fiber_100g;

  const page = await openPage(browser, {
    scripts: [[installDb], [noCamera], [mockOff, { mode: "ok", body: kjOnly }]],
  });
  await scanTo(page, "5010029000016");
  await page.waitForSelector("#sc-amt", { timeout: 5000 });

  // 1585 kJ / 4.184 = 378.8
  check("converts kJ to kcal", await page.inputValue("#sc-calories"), "378.8");
  checkTruthy("says so", (await page.textContent(".flow")).includes("converted from kJ"));
  checkTruthy("flags the value OFF doesn't have",
    (await page.textContent(".warn-note")).includes("fiber"));
  noPageErrors(page);
  await page.close();
}

/* ---------- product not in the database ---------- */
{
  console.log("\nunknown product");
  const page = await openPage(browser, {
    scripts: [[installDb], [noCamera], [mockOff, { mode: "ok", body: { code: "1", status: 0 } }]],
  });
  await scanTo(page, "5010029000016");
  await page.waitForSelector(".error-panel", { timeout: 5000 });
  checkTruthy("says OFF doesn't have it",
    (await page.textContent(".error-head")).includes("doesn't have this barcode"));
  check("offers a way forward",
    await page.$$eval(".error-panel button", (e) => e.map((x) => x.textContent.trim())),
    ["Scan again", "Enter by hand"]);
  noPageErrors(page);
  await page.close();
}

/* ---------- the request itself is blocked (what a published artifact does) ---------- */
{
  console.log("\nlookup blocked");
  const page = await openPage(browser, {
    scripts: [[installDb], [noCamera], [mockOff, { mode: "blocked" }]],
  });
  await scanTo(page, "5010029000016");
  await page.waitForSelector(".error-panel", { timeout: 5000 });
  checkTruthy("explains where lookups do work",
    (await page.textContent(".error-head")).includes("can't reach Open Food Facts"));
  checkTruthy("and that saving once fixes it for good",
    (await page.textContent(".error-detail")).includes("recognised here from then on"));
  noPageErrors(page);
  await page.close();
}

/* ---------- decoding a real barcode image ---------- */
// A genuine EAN-13 (501002900001 + check digit), rendered to PNG and pushed
// through the same photo path the phone uses when a live viewfinder is blocked.
{
  console.log("\ndecoding a real barcode");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const IMG = join(dirname(fileURLToPath(import.meta.url)), ".ean13.png");

  if (!existsSync(IMG)) {
    console.log("  SKIP  no .ean13.png (generate one to enable this check)");
  } else {
    const page = await openPage(browser, {
      scripts: [[installDb], [noCamera], [mockOff, { mode: "ok", body: CEREAL }]],
    });
    await page.click(methodByName("Scan barcode"));
    await page.waitForSelector("input[capture]", { timeout: 5000 });
    await page.setInputFiles("input[capture]", IMG);
    await page.waitForSelector("#sc-amt", { timeout: 15000 });

    const url = (await page.evaluate(() => window.__offCalls))[0];
    checkTruthy("reads the digits off a real barcode image",
      url.includes("/api/v2/product/5010029000016.json"));
    checkText("and goes on to the product", await page.inputValue("#sc-name"), "Porridge Oats");
    noPageErrors(page);
    await page.close();
  }
}

await browser.close();
finish("barcode");
