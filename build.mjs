// Build MacroLog into a single self-contained HTML file.
//
//   node build.mjs            -> dist/macrolog.html        (the file you publish)
//   node build.mjs --local    -> also dist/macrolog.local.html (for tests, no CDN)
//   node build.mjs --watch    -> rebuild both on every save
//
// Why a build step at all: the published page must not depend on an in-browser
// JSX transform. Babel-in-the-browser is a second CDN script that can fail, and
// it costs the viewer a compile on every load. So JSX is compiled here and the
// page ships plain JS.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

// Pinned exactly. cdnjs is one of the few hosts the Artifact CSP allows, and an
// unpinned or wrong path 404s silently — a blank page with no console error.
const REACT_CDN = "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js";
const REACT_DOM_CDN = "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js";
const FONTS_HREF =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Figtree:wght@400;500;600&display=swap">';

/* Your own Supabase project, if you have set one up. Both values are public by
   design — the anon key can only do what row-level security permits. A build
   with no config simply has no account backend, and the SDK is aliased away so
   its 128 kB never ships. */
async function readBackendConfig() {
  try {
    const raw = await readFile(join(ROOT, "macrolog.config.json"), "utf8");
    const cfg = JSON.parse(raw);
    const url = String(cfg.supabaseUrl || "").trim();
    const key = String(cfg.supabaseAnonKey || "").trim();
    if (!url || !key || url.includes("YOUR-PROJECT") || key.includes("YOUR-ANON")) return null;
    if (/service_role/i.test(key)) {
      throw new Error("that looks like a service_role key — use the anon/public key");
    }
    return { url, key };
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    if (e instanceof SyntaxError) throw new Error("macrolog.config.json is not valid JSON");
    throw e;
  }
}

async function compileApp({ lookups, backend }) {
  const out = await esbuild.build({
    entryPoints: [join(SRC, "app.jsx")],
    loader: { ".jsx": "jsx" },
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    format: "iife",
    target: "es2018",          // Safari 12+; esbuild lowers ?. and ?? for us
    // Bundled because the barcode decoder (@zxing/library) is an npm import.
    // React is NOT bundled — app.jsx reads it off the global that the CDN
    // script defines, so it never appears as an import here.
    bundle: true,
    minify: true,              // zxing is ~1 MB raw; minified the page is ~500 kB
    define: {
      __OFF_LOOKUPS__: String(!!lookups),
      __SUPABASE_URL__: JSON.stringify(backend ? backend.url : ""),
      __SUPABASE_ANON_KEY__: JSON.stringify(backend ? backend.key : ""),
    },
    // No backend configured? Don't ship the SDK at all.
    alias: backend ? {} : { "@supabase/supabase-js": join(SRC, "supabase-stub.js") },
    write: false,
  });
  return out.outputFiles[0].text;
}

async function renderPage(app, outfile) {
  const shell = await readFile(join(SRC, "shell.html"), "utf8");
  if (!shell.includes("/*APP*/")) throw new Error("src/shell.html is missing its /*APP*/ marker");
  // A FUNCTION replacement, never a string: `$&`, `$\'` and friends inside the
  // replacement are otherwise treated as backreferences, and minified code is
  // full of `$`. This silently corrupts the bundle.
  const html = shell.replace("/*APP*/", () => app);
  await writeFile(join(DIST, outfile), html);
  return html;
}

// Resolve a file inside an installed package and express it relative to dist/,
// so this works whatever the install layout is (hoisted, nested, workspaces).
const req = createRequire(import.meta.url);
function assetUrl(pkg, subpath) {
  const pkgDir = dirname(req.resolve(`${pkg}/package.json`));
  return relative(DIST, join(pkgDir, subpath)).split(sep).join("/");
}

// The same page with React and the fonts pulled from node_modules, so the test
// suite runs with no network at all and still renders the real typography.
async function writeLocal(html) {
  const reactPath = assetUrl("react", "umd/react.production.min.js");
  const reactDomPath = assetUrl("react-dom", "umd/react-dom.production.min.js");
  let local = html
    .replace(REACT_CDN, () => reactPath)
    .replace(REACT_DOM_CDN, () => reactDomPath);

  const faces = [];
  for (const [family, pkgName, weights] of [
    ["Archivo", "archivo", [500, 600, 700]],
    ["Figtree", "figtree", [400, 500, 600]],
  ]) {
    for (const w of weights) {
      const href = assetUrl(`@fontsource/${pkgName}`, `files/${pkgName}-latin-${w}-normal.woff2`);
      faces.push(
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:swap;` +
          `src:url('${href}') format('woff2');}`
      );
    }
  }
  const faceBlock = `<style>\n${faces.join("\n")}\n</style>`;
  local = local.replace(FONTS_HREF, () => faceBlock);
  await writeFile(join(DIST, "macrolog.local.html"), local);
}

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + " kB";

async function build({ local, open }) {
  const started = Date.now();
  await mkdir(DIST, { recursive: true });
  const backend = await readBackendConfig();
  const made = [];

  // The artifact build: no outbound lookups and no account backend, because its
  // CSP forbids both. It has the Claude account's own storage instead.
  const artifact = await renderPage(await compileApp({ lookups: false, backend: null }), "macrolog.html");
  made.push(`macrolog.html ${kb(artifact)}`);

  // A build for hosting yourself: Open Food Facts reachable, accounts if configured.
  if (open) {
    const opened = await renderPage(await compileApp({ lookups: true, backend }), "macrolog.open.html");
    made.push(`macrolog.open.html ${kb(opened)}${backend ? " + account" : ""}`);
  }

  // The test build: everything on, React and fonts from node_modules. The suite
  // injects its own client, so it needs the SDK aliased in but no real project.
  if (local) {
    const html = await renderPage(
      await compileApp({ lookups: true, backend: backend || { url: "", key: "" } }),
      "macrolog.local.html"
    );
    await writeLocal(html);
    made.push("macrolog.local.html");
  }

  if (!backend && open) {
    console.log("note: no macrolog.config.json, so macrolog.open.html has no account backend.");
  }
  console.log(`built ${made.join(", ")} in ${Date.now() - started}ms`);
}

const args = new Set(process.argv.slice(2));
const wantLocal = args.has("--local") || args.has("--watch");
const wantOpen = args.has("--open") || args.has("--watch");

await build({ local: wantLocal, open: wantOpen });

if (args.has("--watch")) {
  console.log("watching src/ …");
  let queued = null;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(queued);
    queued = setTimeout(() => {
      build({ local: true, open: true }).catch((e) => console.error("build failed:", e.message));
    }, 80);
  });
}
