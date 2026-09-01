// One-off: find single-token company keys that collide with ordinary English
// words, so the resolver can flag them rather than silently trusting them.
// Output is committed; there is no runtime dependency on the system dictionary.

import fs from "node:fs";
import { tickerMap } from "../src/mining/sec.mjs";
import { normalizeName } from "../src/mining/resolve.mjs";

const DICT = "/usr/share/dict/words";
if (!fs.existsSync(DICT)) {
  console.error(`No dictionary at ${DICT}. Regenerate on a machine that has one.`);
  process.exit(1);
}

const words = new Set(
  fs.readFileSync(DICT, "utf8").split("\n")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z]{3,}$/.test(w))
);

const map = await tickerMap();
const ambiguous = new Set();
for (const [, { title }] of map) {
  const key = normalizeName(title);
  if (key && !key.includes(" ") && words.has(key)) ambiguous.add(key);
}

// Names we want resolved despite colliding with a dictionary word. These are
// high-value counterparties in our sectors; each is a deliberate exception.
const ALLOW = [
  "apple", "micron", "intel", "oracle", "corning", "arm", "onto", "amphenol",
  // Dictionary collisions that are nonetheless significant counterparties in
  // our sectors — contract manufacturing, photonics, aerospace metals,
  // industrials. Each is a deliberate exception, not a blanket relaxation.
  "flex", "coherent", "caterpillar", "chevron", "dover", "xylem", "ati",
  "alphabet", "adobe", "biogen",
];
for (const a of ALLOW) ambiguous.delete(a);

const out = { generated: new Date().toISOString().slice(0, 10), allowed: ALLOW, ambiguous: [...ambiguous].sort() };
fs.writeFileSync(new URL("../src/mining/ambiguous-keys.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`ambiguous single-token keys: ${ambiguous.size}`);
console.log(`sample: ${[...ambiguous].slice(0, 25).join(", ")}`);
