import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat, NotFoundException } from "@zxing/library";
import { createClient } from "@supabase/supabase-js";

const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ============================ constants ============================ */

const MACROS = [
  { key: "protein", label: "Protein", color: "var(--protein)", unit: "g" },
  { key: "carbs", label: "Carbs", color: "var(--carbs)", unit: "g" },
  { key: "fat", label: "Fat", color: "var(--fat)", unit: "g" },
  { key: "fiber", label: "Fiber", color: "var(--fiber)", unit: "g" },
];

const FIELDS = ["calories", "protein", "carbs", "fat", "fiber"];

const DEFAULT_GOALS = { calories: 2450, protein: 180, carbs: 260, fat: 72, fiber: 35 };

const LABEL_PROMPT = [
  "You are reading a photograph of a packaged food's nutrition label.",
  "Extract the numbers EXACTLY as printed. Do not estimate, convert units except where told, or invent a value that is not on the label.",
  "",
  "Reply with ONLY a JSON object of this shape:",
  '{"productName": string|null, "basis": "100g"|"serving", "servingGrams": number|null, "per": {"calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number|null}, "unreadable": string[], "notes": string|null}',
  "",
  "Rules:",
  '- "basis" names the column you read: "100g" for a per-100g or per-100ml column, "serving" for a per-serving or per-portion column. When both are printed, read the per-100g column.',
  '- "servingGrams" is the printed serving size in grams, else null.',
  "- Energy in kcal. If only kJ is printed, divide by 4.184 and round to a whole number.",
  '- "carbs" is total carbohydrate as printed, not the "of which sugars" line.',
  '- "fiber" is dietary fibre; null when the label does not print it.',
  '- Name any field you could not read clearly in "unreadable".',
  '- If the photo is not a nutrition label, reply exactly {"error": "not a label"}.',
].join("\n");

const FOOD_PROMPT = [
  "Estimate the nutrition of the food in this photograph. This is a visual estimate, not a measurement: judge the portion from the plate, bowl, cutlery or hand for scale.",
  "",
  "Reply with ONLY a JSON object of this shape:",
  '{"name": string, "items": [{"name": string, "approxGrams": number}], "total": {"calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number}, "assumptions": string, "confidence": "low"|"medium"|"high"}',
  "",
  "Rules:",
  '- "name" is a short label for the whole plate, two to five words.',
  '- "total" covers only the visible portion. Whole numbers, grams for macros and kcal for calories.',
  '- "assumptions" is one sentence naming the biggest guess you made: portion size, cooking oil, sauce, or a hidden ingredient.',
  '- If no food is visible, reply exactly {"error": "no food visible"}.',
].join("\n");

const DESCRIBE_PROMPT = [
  "Estimate the nutrition of a meal from the description below, using standard nutrition data for the foods named.",
  "Where an amount is not given, assume a typical adult portion and say so.",
  "",
  "Reply with ONLY a JSON object of this shape:",
  '{"name": string, "items": [{"name": string, "approxGrams": number}], "total": {"calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number}, "assumptions": string, "confidence": "low"|"medium"|"high"}',
  "",
  "Rules:",
  '- "name" is a short label for the meal, two to five words.',
  '- "total" covers the whole meal as described. Whole numbers, grams for macros and kcal for calories.',
  '- "assumptions" is one sentence naming the biggest guess you made: portion size, cooking oil, or an ingredient that was not stated.',
  '- If the text does not describe food, reply exactly {"error": "not food"}.',
].join("\n");

// What the viewer is told, per rejection code. Never retried automatically.
const ERROR_COPY = {
  not_granted: "This page isn't allowed to use Claude on your account, so photo logging is off.",
  sampling_disabled: "Claude isn't available for this account, so photo logging is off.",
  not_declared: "Photo logging isn't available on this version of the page.",
  capability_disabled: "Photo logging isn't available in this view.",
  capability_removed: "Photo logging isn't available in this view.",
  images_unavailable: "This view can't send photos to Claude.",
  image_rejected: "That image didn't go through. Try a JPEG or PNG under 20 MB.",
  rate_limited: "Too many requests just now. Give it a minute.",
  session_expired: "Your Claude session expired. Reload the page and sign in again.",
  refused: "Claude wouldn't read that image. Try a different photo.",
  empty_completion: "Nothing came back. Try a sharper, closer photo.",
  invalid_json: "The reading came back garbled.",
  prompt_too_large: "That request was too big to send.",
  invalid_request: "Something's wrong with the request.",
  transform_error: "The image couldn't be prepared.",
  queue_overflow: "The page got ahead of itself. Reload and try again.",
  upstream_error: "The connection dropped before an answer arrived.",
};
// Codes where the feature is gone for this view: stop offering photos entirely.
const FATAL_CODES = new Set([
  "not_granted", "sampling_disabled", "not_declared",
  "capability_disabled", "capability_removed", "images_unavailable",
]);
const copyFor = (code) => ERROR_COPY[code] || ERROR_COPY.upstream_error;
const NO_PHOTO_NOTE = "Photos can't be sent to Claude from this app. Open MacroLog in a web browser to use them \u2014 describing a meal works fine here.";

/* ========================= account backend ========================= */
/* Optional. Filled in at build time from macrolog.config.json so one account
   can hold the log across devices when the app is hosted by you rather than
   published as an artifact. Both values are meant to be public: the anon key
   only lets a caller do what row-level security allows, which here is "read and
   write your own rows and nobody else's". The service_role key must never
   appear in a build. */

const SUPABASE_URL = typeof __SUPABASE_URL__ !== "undefined" ? __SUPABASE_URL__ : "";
const SUPABASE_ANON_KEY = typeof __SUPABASE_ANON_KEY__ !== "undefined" ? __SUPABASE_ANON_KEY__ : "";
const STATE_TABLE = "macrolog_state";

function makeSupabaseClient() {
  // Test seam: the suite injects a fake client so auth and storage can be
  // exercised without a live project.
  if (typeof window !== "undefined" && window.__macrologSupabase) return window.__macrologSupabase;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch (e) {
    return null;
  }
}

/* One table holds everything, keyed by (user_id, kind, key):
     goals  ''            the five daily targets
     day    '2026-09-11'  that day's entries
     meal   '<meal id>'   one saved meal
   Row-level security scopes every query to the signed-in user, so the client
   never has to be trusted to filter correctly. */
function makeSupabaseStorage(client, userId) {
  const table = () => client.from(STATE_TABLE);

  const rowFor = (kind, key, data) => ({
    user_id: userId, kind, key, data, updated_at: new Date().toISOString(),
  });
  const upsert = async (kind, key, data) => {
    const { error } = await table().upsert(rowFor(kind, key, data), { onConflict: "user_id,kind,key" });
    if (error) throw error;
  };
  const readOne = async (kind, key) => {
    const { data, error } = await table().select("data").eq("kind", kind).eq("key", key).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  };

  return {
    backend: "account",
    async getGoals() {
      const d = await readOne("goals", "");
      return { ...DEFAULT_GOALS, ...(d || {}) };
    },
    async setGoals(goals) { await upsert("goals", "", goals); },

    async getDay(date) {
      const d = await readOne("day", date);
      if (!d) return emptyDay(date);
      return { date, entries: Array.isArray(d.entries) ? d.entries : [] };
    },
    async setDay(day) { await upsert("day", day.date, { date: day.date, entries: day.entries }); },

    async listDays(n) {
      const { data, error } = await table()
        .select("key,data").eq("kind", "day").order("key", { ascending: false }).limit(n);
      if (error) throw error;
      return (data || []).map((r) => ({
        date: (r.data && r.data.date) || r.key,
        entries: r.data && Array.isArray(r.data.entries) ? r.data.entries : [],
      }));
    },

    async listMeals() {
      const { data, error } = await table().select("key,data").eq("kind", "meal");
      if (error) throw error;
      return (data || []).map((r) => ({ id: r.key, ...(r.data || {}) }));
    },
    async saveMeal(meal) { await upsert("meal", meal.id, meal); },
    async deleteMeal(id) {
      const { error } = await table().delete().eq("kind", "meal").eq("key", id);
      if (error) throw error;
    },
  };
}

/* ====================== Open Food Facts lookup ====================== */
/* Open, free, no API key. The catch is WHERE it can run: a published artifact
   is served under a CSP that blocks every outbound fetch, so this only
   succeeds when the page runs somewhere without that restriction — locally, or
   on a static host of your own. The UI treats a blocked fetch as a normal,
   explainable outcome rather than an error. */

/* Set at build time. A published artifact runs under a CSP that blocks every
   outbound request, so the lookup is offered only where it can actually work.
   `npm run build` leaves this false; `npm run build:open` turns it on for a
   copy you host yourself. */
const LOOKUPS_ENABLED = typeof __OFF_LOOKUPS__ !== "undefined" ? __OFF_LOOKUPS__ : false;

const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product/";
const OFF_FIELDS =
  "code,product_name,product_name_en,brands,quantity,serving_size,nutriments,nutrition_data_per";

// Barcodes are digits only. EAN-8 through GTIN-14 covers anything on a shelf.
const cleanBarcode = (raw) => String(raw || "").replace(/\D/g, "");
const looksLikeBarcode = (raw) => {
  const d = cleanBarcode(raw);
  return d.length >= 8 && d.length <= 14;
};

// Nutriment keys vary by product and by who entered it, so try the likely
// names in order and accept a string that parses. A missing value stays null
// and is reported rather than silently becoming zero.
function pickNutriment(nutriments, keys) {
  for (const k of keys) {
    const v = nutriments[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const f = parseFloat(v.replace(",", "."));
      if (Number.isFinite(f)) return f;
    }
  }
  return null;
}

function parseOffProduct(product, code) {
  const n = (product && product.nutriments) || {};

  let calories = pickNutriment(n, ["energy-kcal_100g", "energy-kcal", "energy-kcal_value"]);
  let energyNote = null;
  if (calories == null) {
    const kj = pickNutriment(n, ["energy-kj_100g", "energy_100g", "energy-kj", "energy"]);
    if (kj != null) { calories = kj / 4.184; energyNote = "Energy converted from kJ."; }
  }

  const values = {
    calories,
    protein: pickNutriment(n, ["proteins_100g", "proteins", "proteins_value"]),
    carbs: pickNutriment(n, ["carbohydrates_100g", "carbohydrates", "carbohydrates_value"]),
    fat: pickNutriment(n, ["fat_100g", "fat", "fat_value"]),
    fiber: pickNutriment(n, ["fiber_100g", "fiber", "fibre_100g", "fibre"]),
  };

  const missing = FIELDS.filter((f) => values[f] == null);
  if (missing.length === FIELDS.length) throw { kind: "no_nutrition" };

  const name = (product.product_name || product.product_name_en || "").trim();
  const brands = (product.brands || "").split(",")[0].trim();
  const servingGrams = parseFloat(String(product.serving_size || "").replace(",", "."));

  return {
    code,
    name: name || brands || `Product ${code}`,
    brands,
    quantity: (product.quantity || "").trim(),
    // OFF normalises to per-100g; nutrition_data_per says what the source was.
    basis: "100g",
    servingGrams: Number.isFinite(servingGrams) && servingGrams > 0 ? servingGrams : null,
    values,
    missing,
    energyNote,
  };
}

async function lookupBarcode(code, signal) {
  const url = `${OFF_BASE}${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if (e && e.name === "AbortError") throw { kind: "cancelled" };
    // A blocked CSP, a dropped connection and an offline phone all land here.
    throw { kind: "blocked" };
  }
  if (res.status === 404) throw { kind: "not_found" };
  if (!res.ok) throw { kind: "http", status: res.status };

  let body;
  try { body = await res.json(); } catch (e) { throw { kind: "bad_json" }; }
  if (!body || body.status === 0 || !body.product) throw { kind: "not_found" };
  return parseOffProduct(body.product, code);
}

const LOOKUP_COPY = {
  not_found: "Open Food Facts doesn't have this barcode yet.",
  no_nutrition: "Open Food Facts has this product but no nutrition values for it.",
  blocked: "This view can't reach Open Food Facts. Lookups work when MacroLog runs from your own browser or host, not inside the Claude app.",
  bad_json: "Open Food Facts sent something unreadable.",
  http: "Open Food Facts is having trouble right now.",
};

/* ============================ helpers ============================ */

const pad = (n) => String(n).padStart(2, "0");
// Local calendar date, not UTC: a meal at 00:30 in Amsterdam belongs to that day.
const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = localISO(new Date());
const parseISO = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const shiftISO = (iso, n) => {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return localISO(d);
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyDate = (iso) => {
  const d = parseISO(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const relDate = (iso) =>
  iso === TODAY ? "Today" : iso === shiftISO(TODAY, -1) ? "Yesterday" : prettyDate(iso);

const num = (v, fallback = 0) => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round = (n) => Math.round(num(n));
const dec1 = (n) => String(Math.round(num(n) * 10) / 10);
const clampPct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const fmt = (n) => round(n).toLocaleString("en-US").replace(/,/g, " ");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const emptyDay = (date) => ({ date, entries: [] });
// Most-reached-for first: what you log daily should sit at the front.
const sortMeals = (arr) => arr.slice().sort((a, b) =>
  (b.useCount || 0) - (a.useCount || 0) ||
  String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || "")) ||
  String(a.name || "").localeCompare(String(b.name || "")));
const sumDay = (day) => {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  (day.entries || []).forEach((e) => FIELDS.forEach((f) => { t[f] += num(e[f]); }));
  return t;
};

/* ============================ storage ============================ */
/* One small surface over two backends: the artifact `db` capability when the
   page has it, else this browser's localStorage. Same keys either way:
   entries/<date> for a day's log, settings/goals for the targets. */

function makeStorage(db) {
  const LS_DAY = (date) => `entries:${date}`;
  const LS_GOALS = "settings:goals";

  const lsGet = (k, fb) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fb;
    } catch (e) { return fb; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
  };

  if (!db) {
    return {
      backend: "local",
      async getGoals() { return { ...DEFAULT_GOALS, ...lsGet(LS_GOALS, {}) }; },
      async setGoals(goals) { lsSet(LS_GOALS, goals); },
      async getDay(date) { return lsGet(LS_DAY(date), emptyDay(date)); },
      async setDay(day) { lsSet(LS_DAY(day.date), day); },
      async listDays(n) {
        const out = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("entries:")) out.push(lsGet(k, null));
          }
        } catch (e) { /* ignore */ }
        return out.filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n);
      },
      async listMeals() { return lsGet("meals", []); },
      async saveMeal(meal) {
        const all = lsGet("meals", []).filter((m) => m.id !== meal.id);
        all.push(meal);
        lsSet("meals", all);
      },
      async deleteMeal(id) { lsSet("meals", lsGet("meals", []).filter((m) => m.id !== id)); },
    };
  }

  return {
    backend: "db",
    async getGoals() {
      const snap = await db.doc("settings/goals").get();
      return snap.exists ? { ...DEFAULT_GOALS, ...snap.data() } : { ...DEFAULT_GOALS };
    },
    async setGoals(goals) {
      await db.doc("settings/goals").set({ ...goals, updatedAt: new Date().toISOString() });
    },
    async getDay(date) {
      const snap = await db.doc(`entries/${date}`).get();
      if (!snap.exists) return emptyDay(date);
      const data = snap.data() || {};
      return { date, entries: Array.isArray(data.entries) ? data.entries : [] };
    },
    async setDay(day) {
      await db.doc(`entries/${day.date}`).set({
        date: day.date,
        entries: day.entries,
        updatedAt: new Date().toISOString(),
      });
    },
    async listDays(n) {
      const snap = await db.collection("entries").orderBy("date", "desc").limit(n).get();
      return snap.docs.map((d) => {
        const data = d.data() || {};
        return { date: data.date || d.id, entries: Array.isArray(data.entries) ? data.entries : [] };
      });
    },
    async listMeals() {
      const snap = await db.collection("meals").get();
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    },
    async saveMeal(meal) { await db.doc(`meals/${meal.id}`).set(meal); },
    async deleteMeal(id) { await db.doc(`meals/${id}`).delete(); },
  };
}

/* ============================ primitives ============================ */

/**
 * Turns "these are the numbers per 100 g / per serving" plus "this is how much
 * I ate" into the amounts that get logged.
 *
 * A serving column with no printed weight can only be counted in servings;
 * everything else is counted in grams. Only the FINAL figures are rounded —
 * rounding the per-100g values first would wipe out sub-gram amounts once they
 * are multiplied up.
 */
function usePortionScaling(parsed, amount) {
  const byServings = !!parsed && parsed.basis === "serving" && !num(parsed.servingGrams);

  const factor = useMemo(() => {
    if (!parsed) return 0;
    const a = num(amount);
    if (byServings) return a;
    if (parsed.basis === "100g") return a / 100;
    const sg = num(parsed.servingGrams);
    return sg > 0 ? a / sg : 0;
  }, [parsed, amount, byServings]);

  const scaled = useMemo(() => {
    const out = {};
    FIELDS.forEach((f) => { out[f] = parsed ? round(num(parsed[f]) * factor) : 0; });
    return out;
  }, [parsed, factor]);

  return { byServings, factor, scaled };
}

function Rule({ heavy }) {
  return <div className={heavy ? "rule rule-heavy" : "rule"} />;
}

function Bar({ value, goal, color }) {
  const p = clampPct(value, goal);
  const over = goal > 0 && value > goal;
  return (
    <div className="bar-track">
      <div
        className={"bar-fill" + (over ? " is-over" : "")}
        style={{ width: `${p}%`, background: over ? "var(--over)" : color }}
      />
    </div>
  );
}

function Field({ id, label, value, onChange, suffix, type = "number", placeholder, autoFocus }) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          id={id}
          type={type}
          inputMode={type === "number" ? "decimal" : undefined}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix ? <span className="field-suffix">{suffix}</span> : null}
      </span>
    </label>
  );
}

function Chip({ tone = "neutral", children }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

function Spinner({ label }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" />
      <span>{label}</span>
    </div>
  );
}

function ErrorPanel({ code, message, onRetry, onManual }) {
  const fatal = FATAL_CODES.has(code);
  return (
    <div className="error-panel" role="alert">
      <div className="error-head">{copyFor(code)}</div>
      {message ? <div className="error-detail">{message}</div> : null}
      {code ? <div className="error-code">reported as: {code}</div> : null}
      <div className="row-actions">
        {!fatal && onRetry ? (
          <button className="btn" onClick={onRetry}>Try again</button>
        ) : null}
        <button className="btn btn-primary" onClick={onManual}>Enter by hand</button>
      </div>
    </div>
  );
}

/* ============================ totals panel ============================ */
/* The day's numbers, set like the nutrition panel on a package: heavy rules
   around the calorie line, hairlines between macros, figures right-aligned. */

function TotalsPanel({ totals, goals, date }) {
  const calPct = clampPct(totals.calories, goals.calories);
  const calOver = totals.calories > goals.calories;
  const left = goals.calories - totals.calories;

  return (
    <section className="panel" aria-label="Daily totals">
      <div className="panel-head">
        <span className="panel-title">Nutrition</span>
        <span className="panel-date">{relDate(date)}</span>
      </div>

      <Rule heavy />

      <div className="cal-row">
        <div className="cal-left">
          <span className="cal-label">Calories</span>
          <span className="cal-sub">
            {calOver
              ? `${fmt(Math.abs(left))} kcal over goal`
              : `${fmt(left)} kcal left`}
          </span>
        </div>
        <div className="cal-right">
          <span className="cal-value">{fmt(totals.calories)}</span>
          <span className="cal-goal">/ {fmt(goals.calories)}</span>
        </div>
      </div>
      <Bar value={totals.calories} goal={goals.calories} color="var(--ink)" />
      <div className="pct-line">
        <span>{Math.round(calPct)}% of goal</span>
        {calOver ? <Chip tone="over">Over</Chip> : null}
      </div>

      <Rule heavy />

      {MACROS.map((m, i) => {
        const v = totals[m.key];
        const g = goals[m.key];
        const over = v > g;
        return (
          <div key={m.key}>
            {i > 0 ? <Rule /> : null}
            <div className="macro-row">
              <span className="macro-name">
                <span className="swatch" style={{ background: m.color }} />
                {m.label}
              </span>
              <span className="macro-values">
                <span className="macro-value">{fmt(v)}</span>
                <span className="macro-goal">/ {fmt(g)} {m.unit}</span>
                <span className={"macro-pct" + (over ? " is-over" : "")}>
                  {Math.round(clampPct(v, g))}%
                </span>
              </span>
            </div>
            <Bar value={v} goal={g} color={m.color} />
          </div>
        );
      })}
    </section>
  );
}

/* ============================ entry list ============================ */

function EntryList({ entries, onRemove, onSaveAsMeal }) {
  if (!entries.length) {
    return (
      <div className="empty">
        Nothing logged yet. Add something below.
      </div>
    );
  }
  return (
    <ul className="entry-list">
      {entries.slice().reverse().map((e) => (
        <li key={e.id} className="entry">
          <div className="entry-main">
            <div className="entry-name">
              {e.name}
              {e.estimate ? <Chip tone="est">Est</Chip> : null}
            </div>
            <div className="entry-meta">
              {e.grams ? `${fmt(e.grams)} g · ` : ""}
              {fmt(e.protein)}p · {fmt(e.carbs)}c · {fmt(e.fat)}f · {fmt(e.fiber)} fib
            </div>
          </div>
          <div className="entry-cal">
            <span>{fmt(e.calories)}</span>
            <span className="entry-unit">kcal</span>
          </div>
          {onSaveAsMeal && !e.mealId ? (
            <button className="bookmark-btn" title="Save as a meal"
                    aria-label={`Save ${e.name} as a meal`} onClick={() => onSaveAsMeal(e)}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M6 3h12a1 1 0 0 1 1 1v16l-7-4-7 4V4a1 1 0 0 1 1-1z" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <button className="icon-btn" aria-label={`Remove ${e.name}`} onClick={() => onRemove(e.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ============================ add methods ============================ */

function AddMethods({ onPick, photosOn, photoNote, canAsk, canScan, lookupEnabled }) {
  return (
    <div className="methods">
      {canScan ? (
        <button className="method" onClick={() => onPick("scan")}>
          <span className="method-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" strokeLinecap="round" />
              <path d="M7.5 8.5v7M10.5 8.5v7M13.5 8.5v7M16.5 8.5v7" strokeLinecap="round" />
            </svg>
          </span>
          <span className="method-text">
            <strong>Scan barcode</strong>
            <em>{lookupEnabled
              ? "Point at the pack, pull the numbers"
              : "Products you've already saved"}</em>
          </span>
        </button>
      ) : null}

      {photosOn ? (
        <>
          <button className="method" onClick={() => onPick("label")}>
            <span className="method-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h4" strokeLinecap="round" />
              </svg>
            </span>
            <span className="method-text">
              <strong>Label photo</strong>
              <em>Read the panel, scale to grams eaten</em>
            </span>
          </button>

          <button className="method" onClick={() => onPick("photo")}>
            <span className="method-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.2-2h7.2l1.2 2h1.7A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
                <circle cx="12" cy="13" r="3.4" />
              </svg>
            </span>
            <span className="method-text">
              <strong>Food photo</strong>
              <em>Estimate the plate in front of you</em>
            </span>
          </button>
        </>
      ) : null}

      {canAsk ? (
        <button className="method" onClick={() => onPick("describe")}>
          <span className="method-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M20 15.5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3H6.5A2.5 2.5 0 0 1 4 15.5v-8A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5z" strokeLinejoin="round" />
              <path d="M8.5 9.5h7M8.5 13h4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="method-text">
            <strong>Describe it</strong>
            <em>Say what you ate, get the macros back</em>
          </span>
        </button>
      ) : null}

      <button className="method" onClick={() => onPick("manual")}>
        <span className="method-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M4 20h16M6 16l9.5-9.5a2.1 2.1 0 0 0-3-3L3 13v3h3z" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="method-text">
          <strong>By hand</strong>
          <em>Type the numbers yourself</em>
        </span>
      </button>

      {photoNote ? <p className="method-note">{photoNote}</p> : null}
    </div>
  );
}

/* ============================ photo picker ============================ */

// A live viewfinder in the page. Falls back to the phone's own camera app when
// getUserMedia is unavailable, which is the common case inside a framed page.
function CameraSheet({ onShot, onCancel, onUnavailable }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const unavailRef = useRef(onUnavailable);
  const [facing, setFacing] = useState("environment");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { unavailRef.current = onUnavailable; });

  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
    (async () => {
      stop();
      setLive(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing } }, audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          try { await v.play(); } catch (e) { /* autoplay policy; the frame still paints */ }
        }
        setLive(true);
      } catch (e) {
        if (!cancelled) unavailRef.current(e && e.name === "NotAllowedError" ? "blocked" : "unavailable");
      }
    })();
    return () => { cancelled = true; stop(); };
  }, [facing]);

  const shoot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setBusy(true);
    const MAX = 1600;                       // plenty for label text; keeps the upload small
    const scale = Math.min(1, MAX / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => { setBusy(false); if (blob) onShot(blob); }, "image/jpeg", 0.9);
  };

  return (
    <div className="cam">
      <div className="cam-stage">
        <video ref={videoRef} className="cam-video" playsInline muted autoPlay />
        {!live ? <div className="cam-wait"><Spinner label="Starting camera…" /></div> : null}
      </div>
      <div className="cam-bar">
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="shutter" onClick={shoot} disabled={!live || busy} aria-label="Take photo">
          <span />
        </button>
        <button className="btn btn-sm" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>
          Flip
        </button>
      </div>
    </div>
  );
}

function PhotoPicker({ accept, onFile, hint }) {
  const camRef = useRef(null);   // capture: opens the camera app straight away
  const libRef = useRef(null);   // no capture: photo library or file dialog
  const [live, setLive] = useState(false);
  const [camNote, setCamNote] = useState(null);

  const canLive = !!(typeof navigator !== "undefined" && navigator.mediaDevices &&
                     navigator.mediaDevices.getUserMedia);

  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) onFile(f);
  };

  return (
    <div className="picker-wrap">
      {/* Both inputs stay mounted so the fallback always has something to click. */}
      <input ref={camRef} className="visually-hidden" type="file" accept={accept}
             capture="environment" onChange={pick} />
      <input ref={libRef} className="visually-hidden" type="file" accept={accept} onChange={pick} />

      {live ? (
        <CameraSheet
          onShot={(blob) => { setLive(false); onFile(blob); }}
          onCancel={() => setLive(false)}
          onUnavailable={(reason) => {
            setLive(false);
            setCamNote(reason === "blocked"
              ? "Camera access was blocked here. Use your camera app instead, or pick a photo."
              : "A live viewfinder isn't available in this view. Your camera app works instead.");
          }}
        />
      ) : (
        <>
          <div className="picker">
            <button className="picker-btn"
                    onClick={() => (canLive && !camNote ? setLive(true) : camRef.current && camRef.current.click())}>
              Take photo
            </button>
            <button className="btn" onClick={() => libRef.current && libRef.current.click()}>
              Choose file
            </button>
          </div>
          {camNote ? <div className="cam-note">{camNote}</div> : null}
          <span className="picker-hint">{hint}</span>
        </>
      )}
    </div>
  );
}

function Preview({ url }) {
  if (!url) return null;
  return <img className="preview" src={url} alt="The photo being read" />;
}

/* ============================ label flow ============================ */

function LabelFlow({ sample, imageAccept, onSave, onCancel, onFatal }) {
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState(null);
  const [phase, setPhase] = useState("pick"); // pick | reading | review | error
  const [err, setErr] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [amount, setAmount] = useState("");
  const ctlRef = useRef(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => { if (ctlRef.current) ctlRef.current.abort(); }, []);

  const read = useCallback(async (f) => {
    setPhase("reading");
    setErr(null);
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      const data = await sample.json(LABEL_PROMPT, {
        images: f,
        signal: ctl.signal,
        cache: false,
      });
      if (!data || typeof data !== "object" || data.error) {
        setErr({ code: "empty_completion", message: data && data.error ? "That doesn't look like a nutrition label." : null });
        setPhase("error");
        return;
      }
      const per = data.per || {};
      const basis = data.basis === "serving" ? "serving" : "100g";
      setParsed({
        productName: typeof data.productName === "string" ? data.productName : "",
        basis,
        servingGrams: data.servingGrams == null ? "" : String(round(data.servingGrams)),
        calories: String(round(per.calories)),
        protein: dec1(per.protein),
        carbs: dec1(per.carbs),
        fat: dec1(per.fat),
        fiber: per.fiber == null ? "" : dec1(per.fiber),
        unreadable: Array.isArray(data.unreadable) ? data.unreadable.filter((x) => typeof x === "string") : [],
        notes: typeof data.notes === "string" ? data.notes : "",
      });
      setAmount(basis === "serving" && data.servingGrams ? String(round(data.servingGrams)) : "");
      setPhase("review");
    } catch (e) {
      if (e && e.code === "cancelled") return;
      const code = (e && e.code) || "upstream_error";
      if (FATAL_CODES.has(code)) onFatal(code);
      setErr({ code, message: null });
      setPhase("error");
    } finally {
      ctlRef.current = null;
    }
  }, [sample, onFatal]);

  const pickFile = (f) => {
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    read(f);
  };

  const { byServings, factor, scaled } = usePortionScaling(parsed, amount);

  const setP = (k) => (v) => setParsed((p) => ({ ...p, [k]: v }));

  if (phase === "pick") {
    return (
      <FlowShell title="Label photo" onCancel={onCancel}>
        <p className="flow-copy">
          Point the camera at the nutrition panel straight on, filling the frame. Claude reads the
          printed numbers; you check them before anything is saved.
        </p>
        <PhotoPicker accept={imageAccept} onFile={pickFile} hint="JPEG, PNG, WebP or GIF" />
      </FlowShell>
    );
  }

  if (phase === "reading") {
    return (
      <FlowShell title="Label photo" onCancel={onCancel}>
        <Preview url={url} />
        <Spinner label="Reading the label…" />
        <button className="btn" onClick={() => { if (ctlRef.current) ctlRef.current.abort(); onCancel(); }}>
          Stop
        </button>
      </FlowShell>
    );
  }

  if (phase === "error") {
    return (
      <FlowShell title="Label photo" onCancel={onCancel}>
        <Preview url={url} />
        <ErrorPanel
          code={err && err.code}
          message={err && err.message}
          onRetry={file ? () => read(file) : null}
          onManual={() => onCancel("manual")}
        />
      </FlowShell>
    );
  }

  const basisLabel = parsed.basis === "100g" ? "per 100 g" : "per serving";

  return (
    <FlowShell title="Check the label" onCancel={onCancel}>
      <Preview url={url} />

      {parsed.unreadable.length ? (
        <div className="warn-note">
          Couldn't read clearly: {parsed.unreadable.join(", ")}. Check those below.
        </div>
      ) : null}
      {parsed.notes ? <div className="soft-note">{parsed.notes}</div> : null}

      <Field id="lb-name" label="Product" type="text" value={parsed.productName}
             onChange={setP("productName")} placeholder="Name on the package" />

      <div className="basis-row">
        <span className="field-label">These numbers are</span>
        <div className="seg seg-sm">
          <button className={parsed.basis === "100g" ? "on" : ""}
                  onClick={() => setParsed((p) => ({ ...p, basis: "100g" }))}>per 100 g</button>
          <button className={parsed.basis === "serving" ? "on" : ""}
                  onClick={() => setParsed((p) => ({ ...p, basis: "serving" }))}>per serving</button>
        </div>
      </div>

      {parsed.basis === "serving" ? (
        <Field id="lb-sg" label="Serving size" value={parsed.servingGrams}
               onChange={setP("servingGrams")} suffix="g" placeholder="blank if not printed" />
      ) : null}

      <div className="mini-panel">
        <div className="mini-head">As printed, {basisLabel}</div>
        <Rule />
        {FIELDS.map((f) => (
          <Field key={f} id={`lb-${f}`} label={f === "calories" ? "Calories" : f[0].toUpperCase() + f.slice(1)}
                 value={parsed[f]} onChange={setP(f)} suffix={f === "calories" ? "kcal" : "g"}
                 placeholder={f === "fiber" ? "not printed" : "0"} />
        ))}
      </div>

      <Field
        id="lb-amt"
        label={byServings ? "How many servings did you eat?" : "How many grams did you eat?"}
        value={amount}
        onChange={setAmount}
        suffix={byServings ? "servings" : "g"}
        autoFocus
      />

      <ScaledSummary values={scaled} show={factor > 0} />

      <div className="row-actions">
        <button className="btn" onClick={() => onCancel()}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!(factor > 0)}
          onClick={() =>
            onSave({
              name: parsed.productName.trim() || "Label entry",
              grams: byServings ? 0 : round(amount),
              method: "label",
              estimate: false,
              ...scaled,
            })
          }
        >
          Save entry
        </button>
      </div>
    </FlowShell>
  );
}

function ScaledSummary({ values, show }) {
  if (!show) return <div className="soft-note">Enter an amount to see what gets logged.</div>;
  return (
    <div className="scaled">
      <div className="scaled-head">Logging</div>
      <div className="scaled-grid">
        <div className="scaled-cell scaled-cal">
          <span className="scaled-v">{fmt(values.calories)}</span>
          <span className="scaled-k">kcal</span>
        </div>
        {MACROS.map((m) => (
          <div key={m.key} className="scaled-cell">
            <span className="scaled-v" style={{ color: m.color }}>{fmt(values[m.key])}</span>
            <span className="scaled-k">{m.label} g</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================ food photo flow ============================ */

function EstimateFlow({ mode, sample, imageAccept, onSave, onCancel, onFatal }) {
  const isText = mode === "text";
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState(null);
  const [phase, setPhase] = useState("pick");
  const [err, setErr] = useState(null);
  const [est, setEst] = useState(null);
  const [vals, setVals] = useState(null);
  const [scale, setScale] = useState(1);
  const ctlRef = useRef(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => { if (ctlRef.current) ctlRef.current.abort(); }, []);

  const read = useCallback(async (input) => {
    setPhase("reading");
    setErr(null);
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      const data = isText
        ? await sample.json(DESCRIBE_PROMPT + "\n\nWhat they ate:\n" + input, { signal: ctl.signal, cache: false })
        : await sample.json(FOOD_PROMPT, { images: input, signal: ctl.signal, cache: false });
      if (!data || typeof data !== "object" || data.error || !data.total) {
        setErr({ code: "empty_completion", message: data && data.error
          ? (isText ? "That didn't read as food. Try naming the foods and amounts." : "No food was visible in that photo.")
          : null });
        setPhase("error");
        return;
      }
      const t = data.total;
      setEst({
        name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Photo estimate",
        items: Array.isArray(data.items) ? data.items.slice(0, 8) : [],
        assumptions: typeof data.assumptions === "string" ? data.assumptions : "",
        confidence: ["low", "medium", "high"].includes(data.confidence) ? data.confidence : "low",
      });
      const base = {};
      FIELDS.forEach((f2) => { base[f2] = round(t[f2]); });
      setVals(base);
      setScale(1);
      setPhase("review");
    } catch (e) {
      if (e && e.code === "cancelled") return;
      const code = (e && e.code) || "upstream_error";
      if (FATAL_CODES.has(code)) onFatal(code);
      setErr({ code, message: null });
      setPhase("error");
    } finally {
      ctlRef.current = null;
    }
  }, [sample, onFatal, isText]);

  const pickFile = (f) => {
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    read(f);
  };

  const applyScale = (next) => {
    const n = Math.max(0.25, Math.min(3, Math.round(next * 100) / 100));
    setVals((v) => {
      const base = {};
      FIELDS.forEach((f) => { base[f] = round((num(v[f]) / scale) * n); });
      return base;
    });
    setScale(n);
  };

  const title = isText ? "Describe the meal" : "Food photo";

  if (phase === "pick") {
    return (
      <FlowShell title={title} onCancel={onCancel}>
        {isText ? (
          <>
            <p className="flow-copy">
              Write what you ate, with amounts where you know them. Claude works the macros out from
              standard nutrition data, and you can adjust anything before saving.
            </p>
            <textarea id="ds-text" className="describe-input" rows={4} value={text} autoFocus
                      placeholder="200 g chicken thigh, 150 g cooked rice, handful of spinach, tbsp olive oil"
                      onChange={(e) => setText(e.target.value)} />
            <div className="row-actions">
              <button className="btn" onClick={() => onCancel()}>Cancel</button>
              <button className="btn btn-primary" disabled={text.trim().length < 3}
                      onClick={() => read(text.trim())}>
                Work out the macros
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="flow-copy">
              Shoot the plate from above with something for scale in frame: cutlery, your hand, the
              table edge. What comes back is an estimate, and you can adjust it before saving.
            </p>
            <PhotoPicker accept={imageAccept} onFile={pickFile} hint="JPEG, PNG, WebP or GIF" />
          </>
        )}
      </FlowShell>
    );
  }

  if (phase === "reading") {
    return (
      <FlowShell title={title} onCancel={onCancel}>
        <Preview url={url} />
        <Spinner label={isText ? "Working out the macros…" : "Estimating the plate…"} />
        <button className="btn" onClick={() => { if (ctlRef.current) ctlRef.current.abort(); onCancel(); }}>
          Stop
        </button>
      </FlowShell>
    );
  }

  if (phase === "error") {
    return (
      <FlowShell title={title} onCancel={onCancel}>
        <Preview url={url} />
        <ErrorPanel code={err && err.code} message={err && err.message}
                    onRetry={isText ? (text ? () => read(text.trim()) : null) : (file ? () => read(file) : null)}
                    onManual={() => onCancel("manual")} />
      </FlowShell>
    );
  }

  return (
    <FlowShell title="Check the estimate" onCancel={onCancel}>
      <Preview url={url} />

      <div className="est-banner">
        <Chip tone="est">Estimate</Chip>
        <span>
          {isText ? "Worked out from your description, not measured." : "Judged from the photo, not measured."}
          {" "}Confidence: {est.confidence}.
        </span>
      </div>

      {est.items.length ? (
        <div className="soft-note">
          Seen: {est.items.map((i) => `${i.name}${i.approxGrams ? ` ~${round(i.approxGrams)} g` : ""}`).join(", ")}
        </div>
      ) : null}
      {est.assumptions ? <div className="soft-note">{est.assumptions}</div> : null}

      <Field id="ph-name" label="Name" type="text" value={est.name}
             onChange={(v) => setEst((e) => ({ ...e, name: v }))} />

      <div className="scale-row">
        <span className="field-label">Portion</span>
        <div className="scale-controls">
          <button className="btn btn-sq" onClick={() => applyScale(scale - 0.25)} aria-label="Smaller portion">−</button>
          <span className="scale-val">{scale.toFixed(2)}×</span>
          <button className="btn btn-sq" onClick={() => applyScale(scale + 0.25)} aria-label="Larger portion">+</button>
        </div>
      </div>

      <div className="mini-panel">
        <div className="mini-head">Adjust anything that looks off</div>
        <Rule />
        {FIELDS.map((f) => (
          <Field key={f} id={`ph-${f}`} label={f === "calories" ? "Calories" : f[0].toUpperCase() + f.slice(1)}
                 value={String(vals[f])} suffix={f === "calories" ? "kcal" : "g"}
                 onChange={(v) => setVals((s) => ({ ...s, [f]: v }))} />
        ))}
      </div>

      <div className="row-actions">
        <button className="btn" onClick={() => onCancel()}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={() => {
            const out = {};
            FIELDS.forEach((f) => { out[f] = round(vals[f]); });
            onSave({ name: est.name.trim() || "Estimate", grams: 0,
                     method: isText ? "describe" : "photo", estimate: true, ...out });
          }}
        >
          Save estimate
        </button>
      </div>
    </FlowShell>
  );
}

/* ============================ manual flow ============================ */

function ManualFlow({ onSave, onCancel }) {
  const [name, setName] = useState("");
  const [grams, setGrams] = useState("");
  const [vals, setVals] = useState({ calories: "", protein: "", carbs: "", fat: "", fiber: "" });
  const set = (k) => (v) => setVals((s) => ({ ...s, [k]: v }));
  const any = FIELDS.some((f) => num(vals[f]) > 0);

  return (
    <FlowShell title="By hand" onCancel={onCancel}>
      <Field id="mn-name" label="Food" type="text" value={name} onChange={setName}
             placeholder="e.g. chicken thighs, rice" autoFocus />
      <Field id="mn-grams" label="Amount" value={grams} onChange={setGrams} suffix="g"
             placeholder="optional" />
      <div className="mini-panel">
        <div className="mini-head">What it came to</div>
        <Rule />
        {FIELDS.map((f) => (
          <Field key={f} id={`mn-${f}`} label={f === "calories" ? "Calories" : f[0].toUpperCase() + f.slice(1)}
                 value={vals[f]} onChange={set(f)} suffix={f === "calories" ? "kcal" : "g"} placeholder="0" />
        ))}
      </div>
      <div className="row-actions">
        <button className="btn" onClick={() => onCancel()}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!name.trim() || !any}
          onClick={() => {
            const out = {};
            FIELDS.forEach((f) => { out[f] = round(vals[f]); });
            onSave({ name: name.trim(), grams: round(grams), method: "manual", estimate: false, ...out });
          }}
        >
          Save entry
        </button>
      </div>
    </FlowShell>
  );
}

function FlowShell({ title, onCancel, children }) {
  return (
    <section className="flow" aria-label={title}>
      <div className="flow-head">
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Close" onClick={() => onCancel()}>×</button>
      </div>
      {children}
    </section>
  );
}

/* ============================ charts ============================ */

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth || 320);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function TrendChart({ series, goal, color, unit, title }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);

  const H = 132;
  const padT = 14, padB = 22, padR = 46;
  const plotH = H - padT - padB;
  const plotW = Math.max(120, w - padR);
  const max = Math.max(goal, ...series.map((d) => d.value)) * 1.18 || 1;
  const y = (v) => padT + plotH - (v / max) * plotH;
  const band = plotW / Math.max(1, series.length);
  const barW = Math.min(26, band * 0.6);
  const logged = series.filter((d) => d.value > 0);

  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-title">
        {title}
        <span className="chart-goal-key">goal {fmt(goal)} {unit}</span>
      </figcaption>

      <div className="chart-plot">
        <svg width={Math.max(160, w)} height={H} role="img"
             aria-label={`${title}. ${logged.length} of ${series.length} days logged.`}>
          {/* goal reference line */}
          <line x1="0" x2={plotW} y1={y(goal)} y2={y(goal)}
                stroke="var(--rule-strong)" strokeWidth="1" strokeDasharray="3 3" />
          <text x={plotW + 6} y={y(goal) + 4} className="chart-tick" fill="var(--ink-3)">
            {fmt(goal)}
          </text>

          {/* baseline */}
          <line x1="0" x2={plotW} y1={padT + plotH} y2={padT + plotH} stroke="var(--rule)" strokeWidth="1" />

          {series.map((d, i) => {
            const cx = i * band + band / 2;
            if (!(d.value > 0)) {
              return (
                <circle key={d.date} cx={cx} cy={padT + plotH} r="1.6" fill="var(--rule-strong)" />
              );
            }
            const top = y(d.value);
            const h = Math.max(3, padT + plotH - top);
            return (
              <rect key={d.date} x={cx - barW / 2} y={top} width={barW} height={h} rx="3"
                    fill={color} opacity={hover && hover.date !== d.date ? 0.45 : 1} />
            );
          })}

          {/* hit targets */}
          {series.map((d, i) => (
            <rect key={`h-${d.date}`} x={i * band} y={padT - 8} width={band} height={plotH + 16}
                  fill="transparent" style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}
                  onTouchStart={() => setHover(d)} />
          ))}

          {series.map((d, i) => {
            if (series.length > 8 && i % 2 === 1) return null;
            const cx = i * band + band / 2;
            return (
              <text key={`t-${d.date}`} x={cx} y={H - 6} textAnchor="middle" className="chart-tick"
                    fill={d.date === TODAY ? "var(--ink)" : "var(--ink-3)"}>
                {WEEKDAYS[parseISO(d.date).getDay()].slice(0, 2)}
              </text>
            );
          })}
        </svg>

        {hover ? (
          <div className="tip" style={{ left: `${Math.min(Math.max(series.indexOf(hover) * band + band / 2, 54), plotW - 54)}px` }}>
            <strong>{prettyDate(hover.date)}</strong>
            <span>{hover.value > 0 ? `${fmt(hover.value)} ${unit}` : "not logged"}</span>
            {hover.value > 0 ? (
              <span className={hover.value > goal ? "tip-over" : "tip-under"}>
                {hover.value > goal ? "+" : "−"}{fmt(Math.abs(hover.value - goal))} vs goal
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </figure>
  );
}

/* ============================ barcode scan ============================ */

// Food barcodes are 1D: EAN-13 on most of the world's packaging, UPC-A in the
// US, EAN-8 on small packs. Restricting the formats keeps the decoder from
// hunting for QR codes in every frame.
const BARCODE_FORMATS = [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, BarcodeFormat.ITF,
];

function makeReader() {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, BARCODE_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, 300);
}

/** Live viewfinder that decodes continuously until it sees a barcode. */
function BarcodeCamera({ onCode, onCancel, onUnavailable }) {
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const doneRef = useRef(false);
  const cbRef = useRef({ onCode, onUnavailable });
  const [live, setLive] = useState(false);

  useEffect(() => { cbRef.current = { onCode, onUnavailable }; });

  useEffect(() => {
    doneRef.current = false;
    const reader = makeReader();
    readerRef.current = reader;

    (async () => {
      try {
        await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          videoRef.current,
          (result, err) => {
            if (doneRef.current) return;
            if (result) {
              doneRef.current = true;
              const code = cleanBarcode(result.getText());
              try { reader.reset(); } catch (e) { /* already stopped */ }
              if (looksLikeBarcode(code)) cbRef.current.onCode(code);
              return;
            }
            // NotFoundException just means "nothing in this frame" — it fires
            // constantly and is not an error.
            if (err && !(err instanceof NotFoundException)) return;
          }
        );
        setLive(true);
      } catch (e) {
        if (!doneRef.current) {
          cbRef.current.onUnavailable(e && e.name === "NotAllowedError" ? "blocked" : "unavailable");
        }
      }
    })();

    return () => {
      doneRef.current = true;
      try { readerRef.current && readerRef.current.reset(); } catch (e) { /* fine */ }
    };
  }, []);

  return (
    <div className="cam">
      <div className="cam-stage cam-stage-wide">
        <video ref={videoRef} className="cam-video" playsInline muted autoPlay />
        <div className="scan-guide" aria-hidden="true" />
        {!live ? <div className="cam-wait"><Spinner label="Starting camera…" /></div> : null}
      </div>
      <p className="flow-copy">Hold the barcode inside the line. It scans on its own.</p>
      <div className="row-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ScanFlow({ meals, lookupEnabled, onLogMeal, onSave, onSaveMeal, onCancel }) {
  const [phase, setPhase] = useState("scan");   // scan | looking | known | review | error
  const [camNote, setCamNote] = useState(null);
  const [manual, setManual] = useState("");
  const [code, setCode] = useState("");
  const [known, setKnown] = useState(null);
  const [product, setProduct] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [amount, setAmount] = useState("");
  const [alsoSave, setAlsoSave] = useState(true);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const ctlRef = useRef(null);

  useEffect(() => () => { if (ctlRef.current) ctlRef.current.abort(); }, []);

  const { byServings, factor, scaled } = usePortionScaling(parsed, amount);

  const handleCode = useCallback(async (raw) => {
    const c = cleanBarcode(raw);
    setCode(c);

    // Something you have already saved wins: it is your own number for your own
    // portion, and it works with no network at all.
    const hit = meals.find((m) => cleanBarcode(m.barcode) === c && c);
    if (hit) { setKnown(hit); setPhase("known"); return; }

    if (!lookupEnabled) { setErr({ kind: "blocked" }); setPhase("error"); return; }

    setPhase("looking");
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      const p = await lookupBarcode(c, ctl.signal);
      setProduct(p);
      setParsed({
        productName: p.name,
        basis: p.basis,
        servingGrams: p.servingGrams == null ? "" : String(p.servingGrams),
        calories: p.values.calories == null ? "" : dec1(p.values.calories),
        protein: p.values.protein == null ? "" : dec1(p.values.protein),
        carbs: p.values.carbs == null ? "" : dec1(p.values.carbs),
        fat: p.values.fat == null ? "" : dec1(p.values.fat),
        fiber: p.values.fiber == null ? "" : dec1(p.values.fiber),
      });
      setAmount(p.servingGrams ? String(p.servingGrams) : "");
      setPhase("review");
    } catch (e) {
      if (e && e.kind === "cancelled") return;
      setErr(e && e.kind ? e : { kind: "blocked" });
      setPhase("error");
    } finally {
      ctlRef.current = null;
    }
  }, [meals, lookupEnabled]);

  // A still photo of the barcode, for when a live viewfinder isn't allowed.
  const decodeStill = async (file) => {
    const url = URL.createObjectURL(file);
    const reader = makeReader();
    try {
      const result = await reader.decodeFromImageUrl(url);
      handleCode(result.getText());
    } catch (e) {
      setErr({ kind: "undecodable" });
      setPhase("error");
    } finally {
      try { reader.reset(); } catch (e) { /* fine */ }
      URL.revokeObjectURL(url);
    }
  };

  const setP = (k) => (v) => setParsed((p) => ({ ...p, [k]: v }));

  const saveEntry = () => {
    const entry = {
      name: (parsed.productName || "").trim() || `Product ${code}`,
      grams: byServings ? 0 : round(amount),
      method: "barcode",
      estimate: false,
      barcode: code,
      ...scaled,
    };
    onSave(entry);
    if (alsoSave) {
      onSaveMeal({
        id: uid(),
        name: entry.name,
        grams: entry.grams,
        barcode: code,
        createdAt: new Date().toISOString(),
        useCount: 0,
        lastUsedAt: null,
        ...scaled,
      });
    }
  };

  /* ---------------- scanning ---------------- */
  if (phase === "scan") {
    return (
      <FlowShell title="Scan a barcode" onCancel={onCancel}>
        <input ref={fileRef} className="visually-hidden" type="file" accept="image/*"
               capture="environment"
               onChange={(e) => {
                 const f = e.target.files && e.target.files[0];
                 e.target.value = "";
                 if (f) { setPhase("looking"); decodeStill(f); }
               }} />

        {camNote ? (
          <>
            <div className="soft-note">{camNote}</div>
            <div className="row-actions">
              <button className="btn btn-primary" onClick={() => fileRef.current.click()}>
                Photograph the barcode
              </button>
            </div>
          </>
        ) : (
          <BarcodeCamera
            onCode={handleCode}
            onCancel={() => onCancel()}
            onUnavailable={(reason) =>
              setCamNote(reason === "blocked"
                ? "Camera access was blocked here. Photograph the barcode instead and it will still be read."
                : "A live viewfinder isn't available in this view. Photograph the barcode instead and it will still be read.")}
          />
        )}

        <div className="mini-panel">
          <div className="mini-head">Or type the number under the barcode</div>
          <Rule />
          <Field id="sc-manual" label="Barcode" value={manual} onChange={setManual}
                 placeholder="8712345678901" />
          <div className="row-actions">
            <button className="btn" disabled={!looksLikeBarcode(manual)}
                    onClick={() => handleCode(manual)}>
              Look it up
            </button>
          </div>
        </div>
      </FlowShell>
    );
  }

  /* ---------------- looking it up ---------------- */
  if (phase === "looking") {
    return (
      <FlowShell title="Scan a barcode" onCancel={onCancel}>
        {code ? <div className="soft-note code-line">{code}</div> : null}
        <Spinner label={code ? "Looking it up…" : "Reading the barcode…"} />
        <button className="btn" onClick={() => { if (ctlRef.current) ctlRef.current.abort(); onCancel(); }}>
          Stop
        </button>
      </FlowShell>
    );
  }

  /* ---------------- already one of your saved meals ---------------- */
  if (phase === "known") {
    return (
      <FlowShell title="Saved meal" onCancel={onCancel}>
        <div className="soft-note code-line">{code}</div>
        <div className="known-meal">
          <div className="known-name">{known.name}</div>
          <div className="meal-macros">
            {known.grams ? `${fmt(known.grams)} g · ` : ""}
            {fmt(known.calories)} kcal · {fmt(known.protein)}p · {fmt(known.carbs)}c · {fmt(known.fat)}f · {fmt(known.fiber)} fib
          </div>
        </div>
        <p className="flow-copy">You've saved this one already, so no lookup was needed.</p>
        <div className="row-actions">
          <button className="btn" onClick={() => onCancel()}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onLogMeal(known); onCancel(); }}>
            Log it
          </button>
        </div>
      </FlowShell>
    );
  }

  /* ---------------- nothing usable came back ---------------- */
  if (phase === "error") {
    const kind = (err && err.kind) || "blocked";
    return (
      <FlowShell title="Scan a barcode" onCancel={onCancel}>
        {code ? <div className="soft-note code-line">{code}</div> : null}
        <div className="error-panel" role="alert">
          <div className="error-head">
            {kind === "undecodable"
              ? "That photo didn't contain a readable barcode."
              : LOOKUP_COPY[kind] || LOOKUP_COPY.blocked}
          </div>
          {kind === "blocked" ? (
            <div className="error-detail">
              Everything else still works: read the panel with the camera, or type the numbers in.
              Save it once and the barcode will be recognised here from then on.
            </div>
          ) : null}
          <div className="row-actions">
            <button className="btn" onClick={() => { setErr(null); setCode(""); setPhase("scan"); }}>
              Scan again
            </button>
            <button className="btn btn-primary" onClick={() => onCancel("manual")}>Enter by hand</button>
          </div>
        </div>
      </FlowShell>
    );
  }

  /* ---------------- found: check it, then log it ---------------- */
  return (
    <FlowShell title="Check the product" onCancel={onCancel}>
      <div className="soft-note code-line">
        {code}{product && product.quantity ? ` · ${product.quantity}` : ""}
      </div>

      {product && product.missing.length ? (
        <div className="warn-note">
          Open Food Facts has no {product.missing.join(", ")} for this product. Fill those in
          yourself, or leave them at zero.
        </div>
      ) : null}
      {product && product.energyNote ? <div className="soft-note">{product.energyNote}</div> : null}

      <Field id="sc-name" label="Product" type="text" value={parsed.productName}
             onChange={setP("productName")} placeholder="Name on the package" />
      {product && product.brands ? (
        <div className="soft-note">Brand: {product.brands}</div>
      ) : null}

      <div className="basis-row">
        <span className="field-label">These numbers are</span>
        <div className="seg seg-sm">
          <button className={parsed.basis === "100g" ? "on" : ""}
                  onClick={() => setParsed((p) => ({ ...p, basis: "100g" }))}>per 100 g</button>
          <button className={parsed.basis === "serving" ? "on" : ""}
                  onClick={() => setParsed((p) => ({ ...p, basis: "serving" }))}>per serving</button>
        </div>
      </div>

      {parsed.basis === "serving" ? (
        <Field id="sc-sg" label="Serving size" value={parsed.servingGrams}
               onChange={setP("servingGrams")} suffix="g" placeholder="blank if not printed" />
      ) : null}

      <div className="mini-panel">
        <div className="mini-head">
          From Open Food Facts, {parsed.basis === "100g" ? "per 100 g" : "per serving"}
        </div>
        <Rule />
        {FIELDS.map((f) => (
          <Field key={f} id={`sc-${f}`}
                 label={f === "calories" ? "Calories" : f[0].toUpperCase() + f.slice(1)}
                 value={parsed[f]} onChange={setP(f)}
                 suffix={f === "calories" ? "kcal" : "g"} placeholder="0" />
        ))}
      </div>

      <Field id="sc-amt"
             label={byServings ? "How many servings did you eat?" : "How many grams did you eat?"}
             value={amount} onChange={setAmount} suffix={byServings ? "servings" : "g"} autoFocus />

      <ScaledSummary values={scaled} show={factor > 0} />

      <label className="check-row" htmlFor="sc-keep">
        <input id="sc-keep" type="checkbox" checked={alsoSave}
               onChange={(e) => setAlsoSave(e.target.checked)} />
        <span>Save as a meal, so this barcode logs in one tap next time</span>
      </label>

      <div className="row-actions">
        <button className="btn" onClick={() => onCancel()}>Cancel</button>
        <button className="btn btn-primary" disabled={!(factor > 0)} onClick={saveEntry}>
          Save entry
        </button>
      </div>
    </FlowShell>
  );
}

/* ============================ saved meals ============================ */

function MealStrip({ meals, onAdd, onManage }) {
  if (!meals.length) {
    return (
      <div className="strip-empty">
        <span>Eat the same thing most days? Save it once, then log it with one tap.</span>
        <button className="btn btn-sm" onClick={onManage}>New saved meal</button>
      </div>
    );
  }
  const top = meals.slice(0, 8);
  return (
    <div className="strip">
      <div className="strip-head">
        <span className="section-head-inline">Saved meals</span>
        <button className="link-btn" onClick={onManage}>
          {meals.length > top.length ? `All ${meals.length}` : "Manage"}
        </button>
      </div>
      <div className="strip-chips">
        {top.map((m) => (
          <button key={m.id} className="meal-chip" onClick={() => onAdd(m)}>
            <span className="meal-chip-name">{m.name}</span>
            <span className="meal-chip-macros">
              {fmt(m.calories)} kcal · {fmt(m.protein)}p · {fmt(m.carbs)}c · {fmt(m.fat)}f
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MealForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [grams, setGrams] = useState(initial && initial.grams ? String(initial.grams) : "");
  const [barcode, setBarcode] = useState(initial && initial.barcode ? String(initial.barcode) : "");
  const [vals, setVals] = useState(() => {
    const v = {};
    FIELDS.forEach((f) => { v[f] = initial ? String(initial[f]) : ""; });
    return v;
  });
  const set = (k) => (v) => setVals((s) => ({ ...s, [k]: v }));
  const ok = name.trim() && FIELDS.some((f) => num(vals[f]) > 0);

  return (
    <div className="meal-form">
      <Field id="ml-name" label="Meal name" type="text" value={name} onChange={setName}
             placeholder="e.g. tiramisu_oats" autoFocus />
      <Field id="ml-grams" label="Portion" value={grams} onChange={setGrams} suffix="g"
             placeholder="optional" />
      <Field id="ml-barcode" label="Barcode" value={barcode} onChange={setBarcode}
             placeholder="optional — scan logs it in one tap" />
      <div className="mini-panel">
        <div className="mini-head">What one portion comes to</div>
        <Rule />
        {FIELDS.map((f) => (
          <Field key={f} id={`ml-${f}`} label={f === "calories" ? "Calories" : f[0].toUpperCase() + f.slice(1)}
                 value={vals[f]} onChange={set(f)} suffix={f === "calories" ? "kcal" : "g"} placeholder="0" />
        ))}
      </div>
      <div className="row-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={!ok}
          onClick={() => {
            const out = {};
            FIELDS.forEach((f) => { out[f] = round(vals[f]); });
            onSave({
              id: initial ? initial.id : uid(),
              name: name.trim(),
              grams: round(grams),
              barcode: cleanBarcode(barcode),
              createdAt: initial && initial.createdAt ? initial.createdAt : new Date().toISOString(),
              useCount: initial ? initial.useCount || 0 : 0,
              lastUsedAt: initial ? initial.lastUsedAt || null : null,
              ...out,
            });
          }}>
          {initial ? "Save changes" : "Save meal"}
        </button>
      </div>
    </div>
  );
}

function MealsView({ meals, onSave, onDelete, onAdd }) {
  const [editing, setEditing] = useState(null);   // null | "new" | the meal being edited
  const [confirm, setConfirm] = useState(null);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Saved meals</span>
          <span className="panel-date">{meals.length} saved</span>
        </div>
        <Rule heavy />
        {editing ? (
          <MealForm
            initial={editing === "new" ? null : editing}
            onSave={(m) => { onSave(m); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>New saved meal</button>
        )}
      </section>

      {meals.length === 0 && !editing ? (
        <div className="empty">
          Nothing saved yet. A saved meal keeps a name and its macros, so a breakfast you eat every
          day goes into the log with one tap.
        </div>
      ) : null}

      {meals.length ? (
        <ul className="meal-list">
          {meals.map((m) => (
            <li key={m.id} className="meal-row">
              <div className="meal-main">
                <div className="meal-name">{m.name}</div>
                <div className="meal-macros">
                  {m.grams ? `${fmt(m.grams)} g · ` : ""}
                  {fmt(m.calories)} kcal · {fmt(m.protein)}p · {fmt(m.carbs)}c · {fmt(m.fat)}f · {fmt(m.fiber)} fib
                  {m.useCount ? ` · logged ${m.useCount}×` : ""}
                  {m.barcode ? ` · ${m.barcode}` : ""}
                </div>
              </div>
              {confirm === m.id ? (
                <div className="meal-actions">
                  <button className="btn btn-sm btn-danger" onClick={() => { onDelete(m.id); setConfirm(null); }}>Delete</button>
                  <button className="btn btn-sm" onClick={() => setConfirm(null)}>Keep</button>
                </div>
              ) : (
                <div className="meal-actions">
                  <button className="btn btn-sm btn-primary" onClick={() => onAdd(m)}>Log it</button>
                  <button className="btn btn-sm" onClick={() => setEditing(m)}>Edit</button>
                  <button className="btn btn-sm" onClick={() => setConfirm(m.id)}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/* ============================ views ============================ */

function TodayView({ date, day, goals, onAdd, onRemove, sample, imageAccept, photosOn, photoNote, onFatal,
                     meals, onLogMeal, onManageMeals, onSaveAsMeal, onSaveMeal, lookupEnabled }) {
  const [flow, setFlow] = useState(null);
  const [note, setNote] = useState(null);
  const totals = useMemo(() => sumDay(day), [day]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(t);
  }, [note]);

  const save = (entry) => {
    onAdd({ id: uid(), at: new Date().toISOString(), ...entry });
    setFlow(null);
  };
  const cancel = (next) => setFlow(next === "manual" ? "manual" : null);

  return (
    <>
      <TotalsPanel totals={totals} goals={goals} date={date} />

      {flow === null ? (
        <MealStrip meals={meals} onAdd={onLogMeal} onManage={onManageMeals} />
      ) : null}

      {flow === null ? (
        <AddMethods onPick={setFlow} photosOn={photosOn} photoNote={photoNote}
                    canAsk={!!sample} canScan lookupEnabled={lookupEnabled} />
      ) : null}

      {flow === "label" ? (
        <LabelFlow sample={sample} imageAccept={imageAccept} onSave={save} onCancel={cancel} onFatal={onFatal} />
      ) : null}
      {flow === "photo" ? (
        <EstimateFlow mode="photo" sample={sample} imageAccept={imageAccept}
                      onSave={save} onCancel={cancel} onFatal={onFatal} />
      ) : null}
      {flow === "describe" ? (
        <EstimateFlow mode="text" sample={sample} imageAccept={imageAccept}
                      onSave={save} onCancel={cancel} onFatal={onFatal} />
      ) : null}
      {flow === "scan" ? (
        <ScanFlow meals={meals} lookupEnabled={lookupEnabled}
                  onLogMeal={onLogMeal} onSave={save} onSaveMeal={onSaveMeal} onCancel={cancel} />
      ) : null}
      {flow === "manual" ? <ManualFlow onSave={save} onCancel={cancel} /> : null}

      <h2 className="section-head">Logged {relDate(date).toLowerCase()}</h2>
      {note ? <div className="toast">Saved “{note}” to your meals</div> : null}
      <EntryList
        entries={day.entries || []}
        onRemove={onRemove}
        onSaveAsMeal={(e) => { onSaveAsMeal(e); setNote(e.name); }}
      />
    </>
  );
}

function HistoryView({ days, goals, onOpenDay }) {
  const series = useMemo(() => {
    const byDate = {};
    days.forEach((d) => { byDate[d.date] = sumDay(d); });
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const iso = shiftISO(TODAY, -i);
      const t = byDate[iso];
      out.push({ date: iso, calories: t ? t.calories : 0, protein: t ? t.protein : 0 });
    }
    return out;
  }, [days]);

  const logged = days.filter((d) => (d.entries || []).length > 0);
  const avg = (key) => {
    if (!logged.length) return 0;
    return logged.reduce((a, d) => a + sumDay(d)[key], 0) / logged.length;
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Last 14 days</span>
          <span className="panel-date">{logged.length} logged</span>
        </div>
        <Rule heavy />
        <TrendChart title="Calories" unit="kcal" goal={goals.calories} color="var(--ink)"
                    series={series.map((d) => ({ date: d.date, value: d.calories }))} />
        <Rule />
        <TrendChart title="Protein" unit="g" goal={goals.protein} color="var(--protein)"
                    series={series.map((d) => ({ date: d.date, value: d.protein }))} />
      </section>

      {logged.length ? (
        <div className="avg-row">
          <div className="avg">
            <span className="avg-v">{fmt(avg("calories"))}</span>
            <span className="avg-k">avg kcal</span>
          </div>
          <div className="avg">
            <span className="avg-v" style={{ color: "var(--protein)" }}>{fmt(avg("protein"))}</span>
            <span className="avg-k">avg protein g</span>
          </div>
          <div className="avg">
            <span className="avg-v" style={{ color: "var(--fiber)" }}>{fmt(avg("fiber"))}</span>
            <span className="avg-k">avg fiber g</span>
          </div>
        </div>
      ) : null}

      <h2 className="section-head">Days</h2>
      {logged.length === 0 ? (
        <div className="empty">No days logged yet. Once you log a few, the trend fills in here.</div>
      ) : (
        <ul className="day-list">
          {logged.map((d) => {
            const t = sumDay(d);
            const over = t.calories > goals.calories;
            return (
              <li key={d.date}>
                <button className="day-row" onClick={() => onOpenDay(d.date)}>
                  <span className="day-name">
                    {relDate(d.date)}
                    <em>{d.entries.length} {d.entries.length === 1 ? "entry" : "entries"}</em>
                  </span>
                  <span className="day-nums">
                    <span className="day-cal">{fmt(t.calories)}<em>kcal</em></span>
                    <span className="day-pro" style={{ color: "var(--protein)" }}>{fmt(t.protein)}<em>p</em></span>
                  </span>
                  <Chip tone={over ? "over" : "good"}>{over ? "over" : "under"}</Chip>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function AccountPanel({ client, account, onSignIn, onSignOut, onUpload }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState({ kind: "idle", text: "" });

  if (!client) {
    return (
      <section className="panel">
        <div className="panel-head"><span className="panel-title">Account</span></div>
        <Rule heavy />
        <p className="fine">
          This build has no account backend, so the log lives in this browser only. Setting one up
          takes about five minutes — see “One account across devices” in the README.
        </p>
      </section>
    );
  }

  const send = async () => {
    const addr = email.trim();
    if (!addr) return;
    setState({ kind: "working", text: "Sending…" });
    try {
      await onSignIn(addr);
      setState({ kind: "sent", text: `Check ${addr} for a sign-in link. Open it on this device.` });
    } catch (e) {
      setState({ kind: "error", text: (e && e.message) || "That didn't go through." });
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Account</span>
        <span className="panel-date">
          {account.status === "signed-in" ? "synced" : account.status === "loading" ? "…" : "this device only"}
        </span>
      </div>
      <Rule heavy />

      {account.status === "signed-in" ? (
        <>
          <div className="account-row">
            <div>
              <div className="account-email">{account.email}</div>
              <div className="fine">Everything you log is saved to this account.</div>
            </div>
            <button className="btn btn-sm" onClick={onSignOut}>Sign out</button>
          </div>
          <Rule />
          <div className="account-row">
            <div className="fine">
              Anything logged on this device before you signed in is still stored locally. Copy it up
              once and it joins the account.
            </div>
            <button className="btn btn-sm" onClick={async () => {
              setState({ kind: "working", text: "Copying…" });
              try {
                const n = await onUpload();
                setState({ kind: "sent", text: n ? `Copied ${n} item${n === 1 ? "" : "s"} up.` : "Nothing local to copy." });
              } catch (e) {
                setState({ kind: "error", text: "Some of it didn't copy. Try again." });
              }
            }}>Copy up</button>
          </div>
        </>
      ) : (
        <>
          <p className="fine">
            Sign in and the same log opens on your laptop and your phone. No password — you get a
            link by email.
          </p>
          <Field id="ac-email" label="Email" type="text" value={email} onChange={setEmail}
                 placeholder="you@example.com" />
          <div className="row-actions">
            <button className="btn btn-primary" disabled={!email.trim() || state.kind === "working"}
                    onClick={send}>
              Email me a link
            </button>
          </div>
        </>
      )}

      {state.text ? (
        <div className={state.kind === "error" ? "warn-note" : "soft-note"}>{state.text}</div>
      ) : null}
    </section>
  );
}

function GoalsView({ goals, onSave, backend, photoStatus, accountPanel }) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    FIELDS.forEach((f) => { d[f] = String(goals[f]); });
    return d;
  });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const d = {};
    FIELDS.forEach((f) => { d[f] = String(goals[f]); });
    setDraft(d);
  }, [goals]);

  const calFromMacros = num(draft.protein) * 4 + num(draft.carbs) * 4 + num(draft.fat) * 9;
  const drift = Math.abs(calFromMacros - num(draft.calories));

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Daily goals</span>
        </div>
        <Rule heavy />
        {FIELDS.map((f) => (
          <Field key={f} id={`g-${f}`} label={f === "calories" ? "Calories" : f[0].toUpperCase() + f.slice(1)}
                 value={draft[f]} suffix={f === "calories" ? "kcal" : "g"}
                 onChange={(v) => { setDraft((d) => ({ ...d, [f]: v })); setSaved(false); }} />
        ))}

        {drift > 60 ? (
          <div className="warn-note">
            Your macros add up to {fmt(calFromMacros)} kcal, which is {fmt(drift)} off your calorie
            goal. Fine if that's deliberate.
          </div>
        ) : null}

        <div className="row-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              const out = {};
              FIELDS.forEach((f) => { out[f] = round(draft[f]); });
              onSave(out);
              setSaved(true);
            }}
          >
            Save goals
          </button>
          {saved ? <span className="saved-note">Saved</span> : null}
        </div>
      </section>

      {accountPanel}

      <p className="fine">
        <strong>Photo logging:</strong> {photoStatus}
      </p>

      <p className="fine">
        These started as defaults, not a prescription: edit them to whatever you're actually aiming
        at. {backend === "db"
          ? "Goals and entries are stored with this page, so they follow you to any device you open it on."
          : backend === "account"
          ? "Goals and entries are stored in your account, so they follow you to any device you sign in on."
          : "Right now they're stored in this browser only."}
      </p>
    </>
  );
}

/* ============================ app ============================ */

function App() {
  const [storage, setStorage] = useState(null);
  const [sample, setSample] = useState(null);
  const [imageAccept, setImageAccept] = useState("image/*");
  const [photosOn, setPhotosOn] = useState(false);
  const [photoNote, setPhotoNote] = useState("");
  const [view, setView] = useState("today");
  const [date, setDate] = useState(TODAY);
  const [day, setDay] = useState(() => emptyDay(TODAY));
  const [goals, setGoals] = useState(DEFAULT_GOALS);
  const [days, setDays] = useState([]);
  const [meals, setMeals] = useState([]);
  const [ready, setReady] = useState(false);
  const [db, setDb] = useState(null);
  const [capsDone, setCapsDone] = useState(false);
  // Lazy initialiser: the client is built once, or null when no backend is set.
  const [client] = useState(makeSupabaseClient);
  const [account, setAccount] = useState(
    () => ({ status: makeSupabaseClient() ? "loading" : "off", email: null, userId: null })
  );

  // Resolve capabilities once, then load. Absent capabilities are a normal state.
  useEffect(() => {
    let alive = true;
    (async () => {
      const hasRuntime = !!(window.claude && typeof window.claude.use === "function");
      // Probe both independently: a slow or failed db must not hold up sampling.
      const [db, s] = hasRuntime
        ? await Promise.all([
            window.claude.use("db").catch(() => null),
            window.claude.use("sample").catch(() => null),
          ])
        : [null, null];
      if (!alive) return;

      setDb(db);
      // `sample` IS a function: store it through an updater so React doesn't call it.
      setSample(() => s);

      if (!hasRuntime) {
        setPhotosOn(false);
        setPhotoNote("This page is open outside the Claude app, so it can't reach Claude. Entries go in by hand.");
      } else if (!s) {
        setPhotosOn(false);
        setPhotoNote("Claude isn't available to this page on your account, so entries go in by hand.");
      } else {
        // limits() only ever REFINES what we offer. If the probe is missing or
        // fails, that says nothing about whether an image call would work, so
        // keep the photo options live and let a real failure explain itself.
        let caps = null;
        try {
          if (typeof s.limits === "function") caps = await s.limits();
        } catch (e) { caps = null; }
        if (!alive) return;
        if (caps && caps.images) {
          setPhotosOn(true);
          const types = caps.images.mediaTypes;
          if (Array.isArray(types) && types.length) setImageAccept(types.join(","));
        } else if (caps) {
          // The view answered plainly that it cannot send images. Believe it, and
          // don't let anyone take a photo that has nowhere to go.
          setPhotosOn(false);
          setPhotoNote(NO_PHOTO_NOTE);
        } else {
          // No answer either way: keep photos on and let a real call decide.
          setPhotosOn(true);
        }
      }

      if (alive) setCapsDone(true);
    })();
    return () => { alive = false; };
  }, []);

  // Watch the account session, when there is a backend to watch.
  useEffect(() => {
    if (!client) return;
    let alive = true;

    const apply = (session) => {
      if (!alive) return;
      setAccount(session && session.user
        ? { status: "signed-in", email: session.user.email || null, userId: session.user.id }
        : { status: "signed-out", email: null, userId: null });
    };

    client.auth.getSession()
      .then((r) => apply(r && r.data ? r.data.session : null))
      .catch(() => apply(null));

    const sub = client.auth.onAuthStateChange((_event, session) => apply(session));
    return () => {
      alive = false;
      const s = sub && sub.data && sub.data.subscription;
      if (s && typeof s.unsubscribe === "function") s.unsubscribe();
    };
  }, [client]);

  /* Which store is in charge, in order of preference:
       1. the artifact's own db, which already follows the Claude account
       2. a signed-in MacroLog account, for builds hosted outside the artifact
       3. this browser's localStorage
     Changing account re-points storage, and the reload below refetches. */
  useEffect(() => {
    if (!capsDone) return;
    if (client && account.status === "loading") return;

    const st = db ? makeStorage(db)
      : (client && account.status === "signed-in") ? makeSupabaseStorage(client, account.userId)
      : makeStorage(null);
    setStorage(st);

    let alive = true;
    setReady(false);
    (async () => {
      try {
        const [g, d0, list, ms] = await Promise.all([
          st.getGoals(), st.getDay(TODAY), st.listDays(14), st.listMeals(),
        ]);
        if (!alive) return;
        setGoals(g);
        setDay(d0);
        setDays(list);
        setMeals(sortMeals(ms));
      } catch (e) {
        if (!alive) return;
        // A backend that refuses is not a reason to show nothing.
        setDays([]); setMeals([]);
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
  }, [capsDone, db, client, account.status, account.userId]);

  // Load whichever day is on screen.
  useEffect(() => {
    if (!storage) return;
    let alive = true;
    storage.getDay(date).then((d) => { if (alive) setDay(d); }).catch(() => {});
    return () => { alive = false; };
  }, [storage, date]);

  const persist = useCallback((next) => {
    setDay(next);
    setDays((prev) => {
      const rest = prev.filter((d) => d.date !== next.date);
      return [next, ...rest].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);
    });
    if (storage) storage.setDay(next).catch(() => {});
  }, [storage]);

  const addEntry = useCallback((entry) => {
    persist({ date, entries: [...(day.entries || []), entry] });
  }, [persist, date, day]);

  const removeEntry = useCallback((id) => {
    persist({ date, entries: (day.entries || []).filter((e) => e.id !== id) });
  }, [persist, date, day]);

  const saveMeal = useCallback((meal) => {
    setMeals((prev) => sortMeals([...prev.filter((m) => m.id !== meal.id), meal]));
    if (storage) storage.saveMeal(meal).catch(() => {});
  }, [storage]);

  const deleteMeal = useCallback((id) => {
    setMeals((prev) => prev.filter((m) => m.id !== id));
    if (storage) storage.deleteMeal(id).catch(() => {});
  }, [storage]);

  // One tap: the meal lands on whichever day is open, and moves up the strip.
  const logMeal = useCallback((meal) => {
    const entry = {
      id: uid(), at: new Date().toISOString(), name: meal.name,
      grams: meal.grams || 0, method: "meal", mealId: meal.id, estimate: false,
    };
    FIELDS.forEach((f) => { entry[f] = round(meal[f]); });
    addEntry(entry);
    saveMeal({ ...meal, useCount: (meal.useCount || 0) + 1, lastUsedAt: new Date().toISOString() });
  }, [addEntry, saveMeal]);

  const saveEntryAsMeal = useCallback((entry) => {
    const meal = {
      id: uid(), name: entry.name, grams: entry.grams || 0,
      barcode: entry.barcode || "",
      createdAt: new Date().toISOString(), useCount: 0, lastUsedAt: null,
    };
    FIELDS.forEach((f) => { meal[f] = round(entry[f]); });
    saveMeal(meal);
  }, [saveMeal]);

  const saveGoals = useCallback((g) => {
    setGoals(g);
    if (storage) storage.setGoals(g).catch(() => {});
  }, [storage]);

  const signIn = useCallback(async (email) => {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) throw error;
  }, [client]);

  const signOut = useCallback(async () => {
    try { await client.auth.signOut(); } catch (e) { /* the state change still fires */ }
  }, [client]);

  // One-way copy of whatever this browser holds into the signed-in account.
  // Deliberately manual: silently merging two libraries is how duplicates happen.
  const uploadLocal = useCallback(async () => {
    if (!storage || storage.backend !== "account") return 0;
    const local = makeStorage(null);
    const [g, ds, ms] = await Promise.all([local.getGoals(), local.listDays(365), local.listMeals()]);
    let n = 0;
    for (const d of ds) {
      if (d && d.entries && d.entries.length) { await storage.setDay(d); n++; }
    }
    for (const m of ms) { await storage.saveMeal(m); n++; }
    if (g) { await storage.setGoals(g); n++; }

    const [gg, d0, list, mm] = await Promise.all([
      storage.getGoals(), storage.getDay(date), storage.listDays(14), storage.listMeals(),
    ]);
    setGoals(gg); setDay(d0); setDays(list); setMeals(sortMeals(mm));
    return n;
  }, [storage, date]);

  const onFatal = useCallback((code) => {
    setPhotosOn(false);
    setPhotoNote(code === "images_unavailable"
      ? NO_PHOTO_NOTE
      : copyFor(code) + " Describing a meal or typing it in still works.");
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <h1 className="wordmark">MacroLog</h1>
          <nav className="seg" aria-label="Views">
            {[["today", "Today"], ["meals", "Meals"], ["history", "History"], ["goals", "Goals"]].map(([k, l]) => (
              <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}
                      aria-current={view === k ? "page" : undefined}>{l}</button>
            ))}
          </nav>
        </div>

        {view === "today" ? (
          <div className="datebar">
            <button className="icon-btn" aria-label="Previous day" onClick={() => setDate((d) => shiftISO(d, -1))}>‹</button>
            <span className="datebar-label">{relDate(date)}<em>{prettyDate(date)}</em></span>
            <button className="icon-btn" aria-label="Next day" disabled={date >= TODAY}
                    onClick={() => setDate((d) => (d < TODAY ? shiftISO(d, 1) : d))}>›</button>
          </div>
        ) : null}
      </header>

      <main className="main">
        {!ready ? (
          <div className="boot"><Spinner label="Opening your log…" /></div>
        ) : view === "today" ? (
          <TodayView
            date={date} day={day} goals={goals}
            onAdd={addEntry} onRemove={removeEntry}
            sample={sample} imageAccept={imageAccept}
            photosOn={photosOn && !!sample} photoNote={photoNote}
            onFatal={onFatal}
            meals={meals} onLogMeal={logMeal} onManageMeals={() => setView("meals")}
            onSaveAsMeal={saveEntryAsMeal} onSaveMeal={saveMeal} lookupEnabled={LOOKUPS_ENABLED}
          />
        ) : view === "meals" ? (
          <MealsView meals={meals} onSave={saveMeal} onDelete={deleteMeal}
                     onAdd={(m) => { logMeal(m); setView("today"); }} />
        ) : view === "history" ? (
          <HistoryView days={days} goals={goals}
                       onOpenDay={(d) => { setDate(d); setView("today"); }} />
        ) : (
          <GoalsView goals={goals} onSave={saveGoals} backend={storage ? storage.backend : "local"}
                     photoStatus={photoNote || (photosOn && sample ? "available" : "checking…")}
                     accountPanel={db ? null : (
                       <AccountPanel client={client} account={account}
                                     onSignIn={signIn} onSignOut={signOut} onUpload={uploadLocal} />
                     )} />
        )}
      </main>
    </div>
  );
}

const mount = document.getElementById("root");
if (window.React && window.ReactDOM && mount) {
  if (ReactDOM.createRoot) ReactDOM.createRoot(mount).render(<App />);
  else ReactDOM.render(<App />, mount);
} else if (mount) {
  mount.textContent = "This page needs React, which didn't load. Reload the page to try again.";
}
