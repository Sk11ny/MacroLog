// Minimal zero-dependency static server for the "hosted" MacroLog build.
// Serves dist/macrolog.open.html for every request (it's a single-page app).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FILE = join(ROOT, "dist", "macrolog.open.html");
const PORT = process.env.PORT || 3000;

let cached;
async function getHtml() {
  if (!cached) cached = await readFile(FILE, "utf8");
  return cached;
}

createServer(async (req, res) => {
  try {
    const html = await getHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("MacroLog build not found. Did the build step run? (" + e.message + ")");
  }
}).listen(PORT, () => {
  console.log(`MacroLog listening on port ${PORT}`);
});
