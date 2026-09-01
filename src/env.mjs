// One .env loader, imported by every entry point.
//
// Previously this lived inside the Alpaca client, so any module that did not
// import it silently saw no configuration — the LLM client reported "no key"
// while the key sat in .env.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    // Real environment variables win; empty values never overwrite.
    if (!process.env[k] && v !== "") process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

loadEnv();
