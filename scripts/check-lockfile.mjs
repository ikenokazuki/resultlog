// Every package the lockfile names must come from the npm registry or from Takumi Guard. With the registry configured as
// the guard, npm sends such an entry to the guard first (its replace-registry-host default for registry.npmjs.org, and the
// URL itself for the guard's own), so the guard can refuse it. An entry from any other host, say a git or tarball URL, is
// downloaded from there, past the guard. Dependabot or a contributor could add one without anyone noticing in a lockfile diff.
// Usage: node scripts/check-lockfile.mjs [package-lock.json]
import { existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? "package-lock.json";
if (!existsSync(file)) {
  console.error(`${file} not found: there is nothing to check.`);
  process.exit(1);
}
const allowed = ["https://registry.npmjs.org/", "https://npm.flatt.tech/"];
const lock = JSON.parse(readFileSync(file, "utf8"));
const elsewhere = Object.entries(lock.packages ?? {})
  .filter(([, entry]) => entry.resolved && !allowed.some((prefix) => entry.resolved.startsWith(prefix)))
  .map(([path, entry]) => `${path} -> ${entry.resolved}`);
if (elsewhere.length > 0) {
  console.error(`These entries of ${file} come from neither ${allowed.join(" nor ")}, so they would bypass Takumi Guard:\n${elsewhere.join("\n")}`);
  process.exit(1);
}
console.log(`${file}: every package comes from the npm registry or Takumi Guard.`);
