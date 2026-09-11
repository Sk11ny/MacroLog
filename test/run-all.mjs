// Runs every *.test.mjs in this folder, one at a time, and exits non-zero if
// any of them failed. Each test owns its own browser, so they stay independent.

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const files = (await readdir(HERE)).filter((f) => f.endsWith(".test.mjs")).sort();

let failed = 0;

for (const file of files) {
  console.log(`\n${"─".repeat(60)}\n${file}\n${"─".repeat(60)}`);
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [join(HERE, file)], { stdio: "inherit" }).on("close", resolve);
  });
  if (code !== 0) failed++;
}

console.log(`\n${"═".repeat(60)}`);
console.log(failed === 0 ? `all ${files.length} suites passed` : `${failed} of ${files.length} suites FAILED`);
process.exit(failed === 0 ? 0 : 1);
