/**
 * RestroNex environment configuration report.
 *
 * Reads .env / .env.local (and process env), prints which variables are set
 * — never their values — and exits non-zero when Supabase is incomplete.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const root = process.cwd();
const merged = {};
for (const file of [".env", ".env.local"]) {
  const path = resolve(root, file);
  if (existsSync(path)) Object.assign(merged, parseEnvFile(path));
}

const effective = (key) => process.env[key] || merged[key] || "";

const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];
const optional = ["NEXT_PUBLIC_APP_URL"];

console.log("RestroNex environment check\n");
let complete = true;

for (const key of [...required, ...optional]) {
  const set = effective(key).length > 0;
  const requiredKey = required.includes(key);
  if (requiredKey && !set) complete = false;
  const label = set ? "✅ set" : requiredKey ? "❌ missing" : "·  optional";
  console.log(`  ${label}   ${key}`);
}

console.log("");
if (complete) {
  console.log("Supabase is fully configured.");
} else {
  console.log("Supabase is NOT configured yet — see docs/SUPABASE_SETUP.md.");
  process.exitCode = 1;
}
