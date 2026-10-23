// Checks that installs really go through Takumi Guard (https://shisho.dev/docs/ja/t/guard/quickstart/npm/): the package
// its quickstart names for this is blocked there, so installing it must be refused with a 403. Run it once the guard is
// set up and before any install, so that a job whose guard silently failed to apply stops before it fetches anything.
// --ignore-scripts: even if the package were let through, nothing of it would run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "guard-check-"));
try {
  writeFileSync(join(dir, "package.json"), '{"name":"guard-check","private":true}\n');
  const registry = spawnSync("npm", ["config", "get", "registry"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const run = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@panda-guard/test-malicious"], { cwd: dir, encoding: "utf8" });
  const output = `${run.stdout}\n${run.stderr}`;
  if (run.status === 0) {
    console.error(`The package that Takumi Guard blocks was installed from ${registry}: the guard is not in the path.`);
    process.exit(1);
  }
  if (!/\b403\b/.test(output)) {
    console.error(`The guard could not be verified: the install of the blocked package failed, but not with a 403.\n${output.trim().split("\n").slice(0, 6).join("\n")}`);
    process.exit(1);
  }
  console.log(`Takumi Guard is in the path: the blocked package was refused (403) by ${registry}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
