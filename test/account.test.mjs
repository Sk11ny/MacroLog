// The account backend: signing in, storage switching to it, and the thing the
// whole feature exists for — the same log opening on a second device.
//
// NOTE: no live Supabase project was reachable when this was written, so the
// fake below implements the client surface the app uses (PostgREST-style
// thenable builders, GoTrue-style auth) from its documented behaviour. It is
// not proof the real service behaves identically; the first real sign-in is.

import {
  launch, openPage, newDevice, methodByName, check, checkText, checkTruthy, noPageErrors, finish,
} from "./harness.mjs";

// A stand-in for @supabase/supabase-js. Rows live in localStorage so a second
// page load — standing in for a second device — sees the same account data.
const installFakeSupabase = (opts) => {
  const ROWS = "__fake_rows";
  const SESSION = "__fake_session";
  const readRows = () => { try { return JSON.parse(localStorage.getItem(ROWS) || "[]"); } catch (e) { return []; } };
  const writeRows = (r) => localStorage.setItem(ROWS, JSON.stringify(r));
  const readSession = () => { try { return JSON.parse(localStorage.getItem(SESSION) || "null"); } catch (e) { return null; } };

  window.__fake = { signInCalls: [], signOutCalls: 0 };
  const listeners = [];
  const emit = (session) => listeners.forEach((fn) => { try { fn("x", session); } catch (e) {} });

  const matches = (row, filters) => filters.every(([k, v]) => row[k] === v);

  const builder = (op, filters, mods) => {
    const run = () => {
      let rows = readRows().filter((r) => matches(r, filters));
      if (mods.order) {
        const [k, o] = mods.order;
        rows = rows.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (o && o.ascending === false ? -1 : 1));
      }
      if (mods.limit) rows = rows.slice(0, mods.limit);
      return rows;
    };
    const self = {
      select: () => self,
      eq: (k, v) => builder(op, [...filters, [k, v]], mods),
      order: (k, o) => builder(op, filters, { ...mods, order: [k, o] }),
      limit: (n) => builder(op, filters, { ...mods, limit: n }),
      maybeSingle: async () => ({ data: run()[0] || null, error: null }),
      // PostgREST builders are thenable; awaiting one runs the query.
      then: (res, rej) => {
        let out;
        if (op === "delete") {
          const keep = readRows().filter((r) => !matches(r, filters));
          writeRows(keep);
          out = { data: null, error: null };
        } else {
          out = { data: run(), error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return self;
  };

  const from = () => ({
    select: (cols) => builder("select", [], {}),
    delete: () => builder("delete", [], {}),
    upsert: async (row) => {
      if (opts && opts.failWrites) return { error: { message: "denied" } };
      const rows = readRows();
      const i = rows.findIndex((r) => r.user_id === row.user_id && r.kind === row.kind && r.key === row.key);
      if (i >= 0) rows[i] = row; else rows.push(row);
      writeRows(rows);
      return { error: null };
    },
  });

  window.__macrologSupabase = {
    from,
    auth: {
      getSession: async () => ({ data: { session: readSession() }, error: null }),
      onAuthStateChange: (cb) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {
          const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1);
        } } } };
      },
      // Real life sends an email; here the link is treated as clicked at once,
      // which is the state the app has to handle anyway.
      signInWithOtp: async ({ email }) => {
        window.__fake.signInCalls.push(email);
        if (opts && opts.signInFails) return { error: { message: "rate limit exceeded" } };
        const session = { user: { id: "user-1", email } };
        localStorage.setItem(SESSION, JSON.stringify(session));
        setTimeout(() => emit(session), 10);
        return { error: null };
      },
      signOut: async () => {
        window.__fake.signOutCalls++;
        localStorage.removeItem(SESSION);
        setTimeout(() => emit(null), 10);
        return { error: null };
      },
    },
  };
};

const goGoals = async (page) => {
  await page.click('nav.seg button:text-is("Goals")');
  await page.waitForTimeout(250);
};

const browser = await launch();

/* ---------- signed out: local only, and it says so ---------- */
{
  console.log("signed out");
  const page = await openPage(browser, { initScript: installFakeSupabase, height: 1400 });
  await goGoals(page);
  checkText("offers a sign-in", await page.textContent(".panel-date:right-of(:text('Account'))").catch(() => ""), "this device only");
  checkTruthy("asks for an email", await page.$("#ac-email"));
  checkTruthy("says where data lives",
    (await page.textContent(".fine")).includes("this browser only") ||
    (await page.textContent("main")).includes("this browser only"));
  noPageErrors(page);
  await page.close();
}

/* ---------- signing in switches storage to the account ---------- */
// These three blocks share one browser context, so the session and the fake
// backend rows persist between them the way a real account would.
const device = await newDevice(browser, { height: 1400 });
{
  console.log("\nsigning in");
  const page = await openPage(browser, { context: device, initScript: installFakeSupabase });
  await goGoals(page);
  await page.fill("#ac-email", "stas@example.com");
  await page.click('.panel button:text-is("Email me a link")');
  await page.waitForTimeout(600);

  check("asks the backend for a link", await page.evaluate(() => window.__fake.signInCalls), ["stas@example.com"]);
  checkText("shows who is signed in", await page.textContent(".account-email"), "stas@example.com");
  checkTruthy("and says the log now syncs",
    (await page.textContent("main")).includes("follow you to any device you sign in on"));

  // Log something; it must land in the backend, not just in the browser.
  await page.click('nav.seg button:text-is("Today")');
  await page.waitForTimeout(250);
  await page.click(methodByName("By hand"));
  await page.waitForTimeout(200);
  await page.fill("#mn-name", "tiramisu_oats");
  await page.fill("#mn-calories", "612");
  await page.fill("#mn-protein", "48");
  await page.click(".flow button.btn-primary");
  await page.waitForTimeout(500);

  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("__fake_rows") || "[]"));
  const dayRows = rows.filter((r) => r.kind === "day");
  check("writes a day row to the account", dayRows.length, 1);
  check("scoped to the signed-in user", dayRows[0].user_id, "user-1");
  check("carrying the entry", dayRows[0].data.entries.map((e) => e.name), ["tiramisu_oats"]);
  noPageErrors(page);
  await page.close();
}

/* ---------- the point of the exercise: opening it somewhere else ---------- */
{
  console.log("\nsecond device");
  const page = await openPage(browser, { context: device, initScript: installFakeSupabase });
  // Wipe every local copy first. Whatever shows up now came from the backend
  // and nowhere else — which is the whole claim being tested.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("entries:") || k === "meals" || k === "settings:goals") localStorage.removeItem(k);
    }
  });
  await page.reload();
  await page.waitForTimeout(900);

  checkText("opens straight into the same day", await page.textContent(".cal-value"), "612");
  checkText("with the same entry", await page.textContent(".entry-name"), "tiramisu_oats");
  await goGoals(page);
  checkText("already signed in", await page.textContent(".account-email"), "stas@example.com");
  noPageErrors(page);
  await page.close();
}

/* ---------- signing out drops back to this browser ---------- */
{
  console.log("\nsigning out");
  const page = await openPage(browser, { context: device, initScript: installFakeSupabase });
  await goGoals(page);
  await page.click('.panel button:text-is("Sign out")');
  await page.waitForTimeout(700);

  checkTruthy("asks for an email again", await page.$("#ac-email"));
  await page.click('nav.seg button:text-is("Today")');
  await page.waitForTimeout(400);
  checkText("and shows the local log, not the account's", await page.textContent(".cal-value"), "0");
  noPageErrors(page);
  await page.close();
}

/* ---------- copying a device's existing log into the account ---------- */
{
  console.log("\ncopy local data up");
  const page = await openPage(browser, { initScript: installFakeSupabase, height: 1400 });
  await page.evaluate(() => localStorage.removeItem("__fake_rows"));

  // Log locally first, the way someone would before they ever signed in.
  await page.click(methodByName("By hand"));
  await page.waitForTimeout(200);
  await page.fill("#mn-name", "pre_account_meal");
  await page.fill("#mn-calories", "410");
  await page.click(".flow button.btn-primary");
  await page.waitForTimeout(350);

  await goGoals(page);
  await page.fill("#ac-email", "stas@example.com");
  await page.click('.panel button:text-is("Email me a link")');
  await page.waitForTimeout(700);
  await page.click('.panel button:text-is("Copy up")');
  await page.waitForTimeout(900);

  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("__fake_rows") || "[]"));
  const names = rows.filter((r) => r.kind === "day").flatMap((r) => r.data.entries.map((e) => e.name));
  checkTruthy("the local day reaches the account", names.includes("pre_account_meal"));
  checkTruthy("and it reports what it copied",
    (await page.textContent(".panel .soft-note")).includes("Copied"));
  noPageErrors(page);
  await page.close();
}

/* ---------- a backend that refuses is not a blank screen ---------- */
{
  console.log("\nbackend refuses a write");
  const page = await openPage(browser, {
    initScript: installFakeSupabase, arg: { failWrites: true }, height: 1400,
  });
  await goGoals(page);
  await page.fill("#ac-email", "stas@example.com");
  await page.click('.panel button:text-is("Email me a link")');
  await page.waitForTimeout(700);
  await page.click('nav.seg button:text-is("Today")');
  await page.waitForTimeout(300);
  checkTruthy("the app still renders", await page.$(".cal-value"));
  noPageErrors(page);
  await page.close();
}

/* ---------- a sign-in that fails says so ---------- */
{
  console.log("\nsign-in rejected");
  const page = await openPage(browser, {
    initScript: installFakeSupabase, arg: { signInFails: true }, height: 1400,
  });
  await goGoals(page);
  await page.fill("#ac-email", "stas@example.com");
  await page.click('.panel button:text-is("Email me a link")');
  await page.waitForTimeout(600);
  checkTruthy("surfaces the reason",
    (await page.textContent(".panel .warn-note")).includes("rate limit"));
  noPageErrors(page);
  await page.close();
}

await device.close();
await browser.close();
finish("account");
