# MacroLog

A calorie and macro tracker that runs as a Claude Artifact. It logs food from a
barcode, a nutrition-label photo, a photo of the plate, a written description,
or by hand, and tracks calories, protein, carbs, fat and fiber against goals you
set for each.

The whole app ships as **one self-contained HTML file** (`dist/macrolog.html`,
about 483 kB, most of which is the barcode decoder). There is no server, no
bundler config, and no framework beyond React itself.

---

## Quick start

```bash
npm install          # also fetches a Chromium for the tests
npm run build        # -> dist/macrolog.html       (for publishing as an Artifact)
npm run build:open   # -> dist/macrolog.open.html  (for hosting yourself)
npm test             # builds a local copy and drives it in a real browser
```

Two builds, because two things genuinely differ between them: **Open Food Facts
lookups** and the **account backend**. Both are blocked inside a published
artifact and both work in a build you host. See "Barcode scanning" and "One
account across devices" below.

To work on it:

```bash
npm run watch        # rebuilds on every save in src/
```

Then open `dist/macrolog.local.html` in a browser. That local build swaps the
CDN React and Google Fonts for copies in `node_modules`, so it renders correctly
with no network — but note that **the capabilities are inert there**, so the
page falls back to `localStorage` and hides the Claude-powered options. To see
those work, publish it (below).

---

## Layout

```
macrolog/
├── src/
│   ├── app.jsx           the entire app: ~2300 lines of React
│   ├── shell.html        <title>, fonts, the CSS design system, script tags
│   └── supabase-stub.js  aliased in when a build has no account backend
├── build.mjs          esbuild: compiles JSX, bundles zxing, inlines it all
├── test/
│   ├── harness.mjs            browser setup + fakes for window.claude
│   ├── capabilities.test.mjs  which methods are offered, per runtime shape
│   ├── logging.test.mjs       label / describe / manual / error handling
│   ├── barcode.test.mjs       decoding, Open Food Facts, every failure mode
│   ├── account.test.mjs       sign-in, storage switching, second-device sync
│   ├── meals.test.mjs         saved meals, storage round trip
│   ├── camera.test.mjs        live viewfinder and its fallbacks
│   └── run-all.mjs
└── dist/macrolog.html         the built file you publish
```

`src/app.jsx` is organised top to bottom as: constants and prompts, helpers,
the storage layer, small UI primitives, the flows (label / estimate / manual),
saved meals, charts, the three views, and `App` at the bottom.

---

## How it is built

JSX is compiled **here**, not in the browser. The published page therefore needs
only React itself, loaded from cdnjs:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
```

The alternative — shipping Babel and transforming JSX at load — means a second
large CDN script that can fail, plus a compile on every page view.

`react`, `react-dom` and the `@fontsource` packages are **devDependencies**:
they exist only so the test build can run offline. The published file never
loads anything from `node_modules`.

### Publishing

`dist/macrolog.html` is the file to publish as an Artifact. It must be
published **with two capabilities declared**:

```json
{ "db": {}, "sample": {} }
```

Without `db` the page silently falls back to per-browser `localStorage`.
Without `sample` every Claude-powered logging method disappears and only
"By hand" remains.

---

## Barcode scanning

Point the camera at a packaged product, get its nutrition back, adjust the
portion, log it. Three things happen in order, and each one can stand alone:

1. **Decode.** `@zxing/library` reads EAN-13, EAN-8, UPC-A/E, Code 128 and ITF
   from the video stream, or from a still photo when a live viewfinder isn't
   allowed. This is pure client-side work — no network, works everywhere.
2. **Match what you have saved.** If a saved meal carries that barcode, it logs
   in one tap. No lookup, no network, your own portion and your own numbers.
3. **Look it up.** Unknown barcodes go to Open Food Facts. Free, open, no API
   key, no account, no rate-limit worth worrying about for personal use.

### Where lookups work, and where they don't

Step 3 is the one with a constraint, and it is not Open Food Facts' fault:

> A published Claude Artifact runs under a CSP that blocks **every** outbound
> request. `fetch` to any external host fails, silently.

So the lookup cannot work inside the Claude app, and no API key or proxy
changes that — it is the page's sandbox, not the API.

| build | lookups | how to use it |
|---|---|---|
| `dist/macrolog.html` | off | publish as an Artifact: syncing storage, Claude-powered logging, barcode matching against saved products |
| `dist/macrolog.open.html` | **on** | host it yourself (any static host, or open the file locally): full Open Food Facts lookups |

The switch is one build-time constant, `LOOKUPS_ENABLED`, set through esbuild's
`define`. The UI adapts: with lookups off, the scan option says "products you've
already saved" rather than promising something it cannot do.

Note that the two builds keep **separate libraries**: the artifact stores through
the Claude account, the hosted build through `localStorage` or a MacroLog
account. A product scanned on one does not appear on the other by itself.

### The Open Food Facts response

`GET https://world.openfoodfacts.org/api/v2/product/<barcode>.json?fields=…`

Values are read from `product.nutriments`, preferring the `_100g` keys. The
parser is deliberately forgiving, because the database is crowd-sourced and
uneven:

- energy falls back from `energy-kcal_100g` to kJ ÷ 4.184, and says when it did
- each nutriment tries several key spellings, and accepts a numeric string
- anything genuinely missing is reported by name rather than silently zeroed
- `serving_size` is parsed for a gram figure and prefills the portion field

Every value lands in an editable field before anything is saved, so a wrong
mapping shows up as a number you can fix, not as bad data in your log.

> **Not verified against the live API.** openfoodfacts.org was unreachable from
> the machine this was written on, so the field mapping comes from their
> documented v2 shape, not a captured response. The first real scan is the test.
> If something lands in the wrong box, fix `parseOffProduct` in `src/app.jsx`
> and add the real payload to `test/barcode.test.mjs`.

### Why zxing, at 406 kB

It is most of the page weight, and the alternatives were worse. `BarcodeDetector`
is native and free but absent on iOS Safari, which is the platform this is used
on. A hand-rolled EAN-13 scanline decoder is ~5 kB and fine on a clean render,
but real barcode reading is about blur, angle and glare, which is exactly the
hardening zxing already has. If you only ever scan on Android or desktop Chrome,
swapping in `BarcodeDetector` would cut the page to about 90 kB.

## One account across devices

Three storage backends, picked at runtime in this order:

1. **The artifact's `db`** — when the page runs as a published Claude Artifact.
   Your Claude account *is* the login, and this already syncs across devices
   with no setup at all.
2. **A MacroLog account** — Supabase, for builds you host yourself. Email link,
   no password.
3. **`localStorage`** — no account, this browser only.

You only need the middle one if you host the build yourself (which is what makes
Open Food Facts lookups work). Setting it up takes about five minutes.

### 1. Create the project

Sign up at supabase.com, create a project, and wait for it to finish starting.

### 2. Create the table

Open the SQL editor in your project and run this:

```sql
create table public.macrolog_state (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null check (kind in ('goals', 'day', 'meal')),
  key        text not null default '',
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, key)
);

alter table public.macrolog_state enable row level security;

-- Each person reads and writes their own rows, and nobody else's. This is what
-- makes it safe to put the anon key in a public page.
create policy "own rows only"
  on public.macrolog_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

One table holds everything, keyed by `(user_id, kind, key)`:

| kind | key | data |
|---|---|---|
| `goals` | `''` | the five daily targets |
| `day` | `2026-09-11` | that day's entries |
| `meal` | a meal id | one saved meal |

### 3. Point the build at it

```bash
cp macrolog.config.example.json macrolog.config.json
```

Fill in the **Project URL** and the **anon / public** key from Settings → API:

```json
{
  "supabaseUrl": "https://abcdefgh.supabase.co",
  "supabaseAnonKey": "eyJhbGciOi..."
}
```

Both values are meant to be public — the anon key only permits what the policy
above allows. **Never put the `service_role` key here**; it bypasses row-level
security entirely. The build refuses one that looks like it, and
`macrolog.config.json` is gitignored.

### 4. Build and host

```bash
npm run build:open     # dist/macrolog.open.html
```

Put that file on any static host. Open it, go to **Goals → Account**, enter your
email, click the link that arrives, and you're signed in. Do the same on your
laptop and both show the same log.

Two details worth knowing. Supabase's default email sender is rate-limited and
fine for one person, but for anything beyond that you'd add your own SMTP under
Authentication → Emails. And the sign-in link must be opened on the device that
asked for it, because the session lands in that browser.

### Moving data you already have

Signing in does **not** merge what was already in the browser — silently fusing
two libraries is how you get duplicates. Instead, **Goals → Account → Copy up**
does a one-way copy of this device's days, meals and goals into the account, and
tells you how many items it moved.

There is no automatic bridge between the artifact's storage and a MacroLog
account: they are separate stores behind the same interface. Copying from one to
the other means re-entering, or adding an export/import step.

## The runtime contract

A published artifact reaches Claude through `window.claude.use(name)`. Both
capabilities resolve to `null` when unavailable, which is a normal state the
page has to render for — not an error.

### `db` — storage

```
settings/goals          { calories, protein, carbs, fat, fiber, updatedAt }
entries/<YYYY-MM-DD>    { date, entries: [ … ], updatedAt }
meals/<id>              { id, name, grams, barcode, …macros, useCount, lastUsedAt }
```

One entry looks like:

```js
{ id, at, name, grams, calories, protein, carbs, fat, fiber,
  method: "label" | "photo" | "describe" | "barcode" | "meal" | "manual",
  estimate: boolean,
  mealId?: string,
  barcode?: string }
```

**The one API detail that bites:** a snapshot's `data` is a **method**, not a
property. `snap.data` is the function itself — truthy, and useless. Always:

```js
const snap = await db.doc("entries/2026-09-11").get();
const body = snap.exists ? snap.data() : null;
```

Writes are last-writer-wins with no transactions. Days are keyed by **local**
calendar date, not UTC, so a meal at 00:30 belongs to that day.

### `sample` — asking Claude

`sample.json(prompt, opts)` returns parsed JSON. Images go in `opts.images` as a
`Blob`/`File`. Every call passes `cache: false` (a retry must really retry) and
an `AbortController` signal so Stop actually stops.

Failures **reject** with `{ code, message, text? }`. Branch on `code`, never on
`message`, and never retry from a loop — retrying is always the user's choice.
`ERROR_COPY` in `app.jsx` maps every code to what the viewer is told, and
`FATAL_CODES` lists the ones that mean "stop offering this feature".

---

## Two platform limits worth knowing

**1. The Claude mobile app cannot send images.** On iOS, `sample` works for text
but rejects any call carrying an image with `images_unavailable`. The page asks
`sample.limits()` up front: if it reports no image support, the two photo
methods are hidden and a note points at the browser instead. "Describe it"
exists precisely because it is the good path on a phone.

The gate is deliberately asymmetric, and both halves were learned the hard way:

- `limits()` says **no images** → believe it, hide the photo methods.
- `limits()` **throws or is missing** → that says nothing, so keep the photo
  methods and let a real call fail with a real reason.

**2. The Artifact CSP blocks almost everything.** Scripts load only from a short
allowlist (cdnjs among them); stylesheets only from Google Fonts. All `fetch`,
`XHR` and `WebSocket` traffic to any external host is blocked with no visible
error. So calling `api.anthropic.com` directly from the page is impossible —
`sample` is the supported route, and it runs on the viewer's own Claude account,
with no API key in the page.

---

## Design system

Defined once as CSS custom properties at the top of `src/shell.html`, with a
full light palette on `:root` and dark overrides under both
`@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`, so the viewer's
explicit choice wins in either direction.

The visual language borrows the **nutrition-label panel**: heavy rules around
the calorie line, hairlines between macros, condensed uppercase row labels,
tabular figures right-aligned. Hierarchy comes from rules and type weight rather
than from putting a border and shadow on everything.

Type: **Archivo** for labels, numbers and the panel voice; **Figtree** for body
copy and buttons.

The four macro colours are a colourblind-safe set, checked for perceptual
separation in both themes:

| macro   | light     | dark      |
|---------|-----------|-----------|
| protein | `#2a78d6` | `#3987e5` |
| carbs   | `#eb6834` | `#d95926` |
| fat     | `#1baf7a` | `#199e70` |
| fiber   | `#4a3aa7` | `#9085e9` |

Calories deliberately have no hue — they use plain ink, so the four macro
colours keep their meaning. Status colours (`--good`, `--over`, `--est`) are
reserved for state and never reused as a data series. Every bar carries a
visible number, so colour never has to carry a value on its own.

---

## Tests

The suite drives the **real built file** in Chromium and fakes only
`window.claude`. Nothing in `src/` is stubbed, so a pass means the file you
publish works.

```bash
npm test                          # everything
node test/meals.test.mjs          # one suite
```

`test/harness.mjs` provides the fakes: `installRuntime(mode)` for the `sample`
capability across seven runtime shapes (`desktop`, `mobile`, `no-sample`,
`no-runtime`, `limits-throws`, `limits-no-images`, `no-limits-fn`), and
`installDb()` for a storage fake that honours the real snapshot contract and
survives reloads.

The camera test uses Chromium's fake webcam, so the viewfinder, the shutter and
the resulting JPEG are all exercised for real.

If your Chromium lives somewhere unusual, point at it:

```bash
CHROMIUM_PATH=/path/to/chromium npm test
```

---

## Things that already went wrong here

Kept as a list because each one cost a round trip, and none of them are obvious
from the API docs alone.

- `setSample(s)` — React treats a function passed to a state setter as an
  updater and **calls it**. Storing a function needs `setSample(() => s)`.
- `snap.data` vs `snap.data()` — see above. Reading the property stores the
  function and everything downstream silently breaks.
- `new Date().toISOString().slice(0,10)` is the **UTC** date. In UTC+2 that
  files a late-night meal under the previous day.
- Rounding label values to whole numbers *before* scaling destroys sub-gram
  amounts: 0.4 g/100 g over 500 g is 2 g, not 0.
- `capture="environment"` on a file input forces the camera and removes the
  option of picking an existing photo — so there are two inputs, one of each.
- `String.replace(needle, replacement)` treats `$&`, `` $` `` and `$'` in the
  **replacement** as backreferences. Minified bundles are full of `$`, so
  injecting one into the HTML shell with a string replacement silently corrupts
  it. Pass a function — `replace(needle, () => code)` — and it is literal.
