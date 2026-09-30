import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A JSON file next to this module, not a database: this is a single-site test harness, not a
// multi-tenant CMS. It deliberately mirrors what a real plugin does at a much smaller scale —
// one WordPress site, one stored connection, kept server-side only. Restarting the server does
// NOT lose the connection (unlike the in-memory PKCE map in index.js, which is fine to lose).
const STORE_PATH = path.join(__dirname, ".connection.json");

export function readConnection() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function writeConnection(connection) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(connection, null, 2));
}

export function clearConnection() {
  try {
    fs.unlinkSync(STORE_PATH);
  } catch {
    // Nothing to clear.
  }
}
