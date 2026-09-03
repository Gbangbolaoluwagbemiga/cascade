// Shared journal writer.
//
// The daemon owned journalling, so a trade fired from the web button changed the
// account without leaving any record — the agent log showed nothing while
// positions appeared. Both paths write here now.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.join(fileURLToPath(new URL("../../", import.meta.url)), "data");
const FILE = path.join(DATA, "journal.jsonl");

export function appendJournal(entry) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const line = { at: new Date().toISOString(), ...entry };
    fs.appendFileSync(FILE, JSON.stringify(line) + "\n");
    return line;
  } catch { return null; }
}
