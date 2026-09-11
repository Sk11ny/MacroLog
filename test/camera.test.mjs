// The camera chain: a live viewfinder in the page, falling back to the phone's
// own camera app when a framed page isn't allowed to open one directly.
//
// Uses Chromium's fake webcam (--use-fake-device-for-media-stream), so the
// shutter produces a real JPEG and the whole path can run headlessly.

import { launch, openPage, installRuntime, methodByName, check, checkTruthy, noPageErrors, finish } from "./harness.mjs";

// Init scripts are serialised into the page, so these must be self-contained.
const blockCamera = () => {
  navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
};
const removeCameraApi = () => {
  try { Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true }); }
  catch (e) { /* some engines refuse; the page must cope either way */ }
};

const browser = await launch({ fakeCamera: true });

/* ---------------- live viewfinder ---------------- */
{
  console.log("live viewfinder");
  const page = await openPage(browser, { initScript: installRuntime, arg: "desktop" });
  await page.click(methodByName("Label photo"));
  await page.waitForTimeout(200);

  check("offers both camera and file",
    await page.$$eval(".picker button", (e) => e.map((x) => x.textContent.trim())),
    ["Take photo", "Choose file"]);

  await page.click(".picker-btn");
  await page.waitForSelector(".cam-video", { timeout: 5000 });
  await page.waitForFunction(() => {
    const v = document.querySelector(".cam-video");
    return v && v.videoWidth > 0;
  }, { timeout: 8000 });
  checkTruthy("viewfinder gets a live frame",
    await page.$eval(".cam-video", (v) => v.videoWidth > 0));

  await page.click(".shutter");
  await page.waitForTimeout(900);

  const calls = await page.evaluate(() => window.__calls);
  check("the shot is sent as an image", calls.map((c) => c.hasImages), [true]);
  checkTruthy("and lands on the review screen", await page.$("#lb-amt"));
  check("camera is released after the shot", await page.$(".cam-video"), null);
  noPageErrors(page);
  await page.close();
}

/* ---------------- blocked: explain, don't fail silently ---------------- */
{
  console.log("\ncamera blocked");
  const page = await openPage(browser, {
    scripts: [[installRuntime, "desktop"], [blockCamera]],
  });
  await page.click(methodByName("Food photo"));
  await page.waitForTimeout(200);
  await page.click(".picker-btn");
  await page.waitForTimeout(700);

  checkTruthy("says access was blocked",
    (await page.textContent(".cam-note")).includes("blocked"));
  check("leaves both options usable",
    await page.$$eval(".picker button", (e) => e.map((x) => x.textContent.trim())),
    ["Take photo", "Choose file"]);
  noPageErrors(page);
  await page.close();
}

/* ---------------- no camera API at all ---------------- */
{
  console.log("\nno camera API");
  const page = await openPage(browser, {
    scripts: [[installRuntime, "desktop"], [removeCameraApi]],
  });
  await page.click(methodByName("Label photo"));
  await page.waitForTimeout(200);

  check("keeps a capture input for the OS camera",
    await page.$eval("input[capture]", (i) => i.getAttribute("capture")), "environment");
  await page.click(".picker-btn");
  await page.waitForTimeout(400);
  check("does not try to open a viewfinder", await page.$(".cam-video"), null);
  noPageErrors(page);
  await page.close();
}

await browser.close();
finish("camera");
